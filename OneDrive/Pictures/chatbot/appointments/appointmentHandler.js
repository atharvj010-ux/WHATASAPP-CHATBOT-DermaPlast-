import { parseDate } from "chrono-node";
import { supabase } from "../tasks/supabaseClient.js";
import { parseClinicDateTime, buildAppointmentRange } from "../crm/datetime.js";
import {
	insertAppointmentVerified,
	resolveCrmOwnerId,
	logCrmDebugSummary,
	findPatientForCrm
} from "../crm/db.js";
import {
	findVisiblePatientDuplicate,
	findVisibleSlotConflicts
} from "../crm/appointmentQueries.js";
import { sendWhatsAppMessage } from "../twilio.js";
import { getSession, setSession } from "../store.js";
import { parseAppointmentIntentFromText } from "./parseAppointmentIntent.js";
import {
	DEFAULT_DURATION_MIN,
	findConflictingAppointments,
	formatShortDateTime,
	formatTimeOnly,
	isSlotWithinBusinessHours,
	suggestAvailableSlots
} from "./slotAvailability.js";
import {
	CRM_ERRORS,
	findPatientOrLeadByName,
	formatAppointmentSuccessMessage,
	isExplicitCrmAppointmentCommand,
	logCrm,
	resolvePatientRecord
} from "../crm/crmIntegration.js";

const DEFAULT_OWNER_ID = process.env.SUPABASE_DEFAULT_OWNER_ID ?? null;
const DEFAULT_CLINICIAN = process.env.WHATSAPP_DEFAULT_CLINICIAN || process.env.DEFAULT_DOCTOR_NAME || "Dr. Saurabh Parjane";
const DEFAULT_LOCATION = process.env.CLINIC_LOCATION || process.env.CLINIC_ADDRESS || null;
const FLOW = "APPOINTMENT_BOOKING";

const BOOK_KEYWORDS =
	/\b(book|schedule|create|fix|set)\b.*\b(appointment|consultation)\b|\bappointment\b.*\bfor\b/i;

const RESCHEDULE_KEYWORDS = /\b(reschedule|re-?schedule|move|change)\b.*\b(appointment|slot|booking)\b/i;
const CANCEL_KEYWORDS = /\b(cancel)\b.*\b(appointment|booking)\b/i;

function looksLikeAppointmentRequest(text) {
	const t = String(text || "");
	if (RESCHEDULE_KEYWORDS.test(t) || CANCEL_KEYWORDS.test(t)) return true;
	return BOOK_KEYWORDS.test(t) || /\bbook\b/i.test(t) && /\b(consultation|treatment|prp|hair)\b/i.test(t);
}

function extractPatientNameFallback(text) {
	const raw = String(text || "");
	const afterFor = raw.match(
		/\b(?:for|with)\s+(.+?)(?=\s+(?:on|at|tomorrow|next|this|patient\b)|\s+\d{1,2}\s+(?:may|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b|$)/i
	)?.[1];
	if (afterFor)
		return afterFor
			.trim()
			.replace(/\s+/g, " ")
			.replace(/\bpatient\b/i, "")
			.trim();
	return null;
}

function inferKindFromText(text, parsedKind) {
	if (parsedKind) return parsedKind;
	const t = String(text || "").toLowerCase();
	if (/\b(follow[\s-]?up)\b/.test(t)) return "followup";
	if (/\b(urgent|emergency)\b/.test(t)) return "urgent";
	if (/\b(treatment|prp|laser|peel|facial|hair\s+transplant)\b/.test(t)) return "treatment";
	if (/\b(consultation|consult)\b/.test(t)) return "consultation";
	return "consultation";
}

function parseNaturalDateTime(text, refDate = new Date()) {
	return parseClinicDateTime(text, refDate);
}

function parseTimeOnly(text, baseDateIso) {
	const t = String(text || "").trim();
	if (!baseDateIso) return null;
	const combined = `${baseDateIso} ${t}`;
	const { timeHHmm, dateIso } = parseNaturalDateTime(combined);
	if (dateIso === baseDateIso && timeHHmm) return timeHHmm;
	const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
	if (!m) return null;
	let hh = Number(m[1]);
	const mm = Number(m[2] || 0);
	const ap = (m[3] || "").toLowerCase();
	if (ap === "pm" && hh < 12) hh += 12;
	if (ap === "am" && hh === 12) hh = 0;
	return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function eveningToHHmm(text) {
	if (!/\bevening\b/i.test(text)) return null;
	return "18:00";
}

async function findPatientByName(name) {
	const scoped = await findPatientForCrm(name);
	if (scoped) return scoped;

	const envOwner = String(process.env.SUPABASE_DEFAULT_OWNER_ID || "").trim();
	if (envOwner) {
		logCrm("patient_lookup_rejected_unscoped", {
			name,
			reason: "Patient not found for CRM owner — refusing global lookup to avoid invisible appointments"
		});
		return null;
	}

	const lookup = await findPatientOrLeadByName(name);
	return resolvePatientRecord(lookup);
}


function mergeDraft(session, patch) {
	const prev = session.appointmentDraft || {};
	return {
		...session,
		flow: FLOW,
		appointmentDraft: { ...prev, ...patch }
	};
}

function clearAppointmentFlow(session) {
	return {
		...session,
		flow: null,
		appointmentDraft: {}
	};
}

function nextMissingField(draft) {
	if (!draft.patientName && !draft.patientId) return "patientName";
	if (!draft.dateIso) return "date";
	if (!draft.timeHHmm) return "time";
	return null;
}

function askForField(field) {
	const prompts = {
		patientName: "Please share the patient's full name as it appears in our records.",
		date: "Which date would you like? (e.g. tomorrow, 23 May, next Monday)",
		time: "What time works best? (e.g. 2 PM, 5:30 PM, evening)"
	};
	return prompts[field] || "Please share a few more details to book the appointment.";
}

/**
 * @returns {Promise<{ handled: boolean }>}
 */
export async function handleAppointmentBookingFromWhatsApp({ from, body }) {
	const text = String(body || "").trim();
	if (!text) return { handled: false };

	const session = getSession(from);
	const inFlow = session.flow === FLOW;
	const draft = session.appointmentDraft || {};

	if (!inFlow && !looksLikeAppointmentRequest(text) && !isExplicitCrmAppointmentCommand(text)) {
		return { handled: false };
	}

	// Greeting/cancel while mid-booking — exit flow and let the AI agent respond.
	if (inFlow && /^(hi|hello|hey|hii|namaste|cancel|stop|exit|quit)\b/i.test(text.trim()) && text.trim().length < 50) {
		setSession(from, clearAppointmentFlow(session));
		return { handled: false };
	}

	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "appointment-handler",
			event: "incoming_booking_request",
			from,
			inFlow,
			textPreview: text.slice(0, 200)
		})
	);

	// Slot choice after conflict
	if (inFlow && draft.awaiting === "slot_choice" && draft.dateIso) {
		const picked = parseTimeOnly(text, draft.dateIso) || parseNaturalDateTime(`${draft.dateIso} ${text}`).timeHHmm;
		if (!picked) {
			await sendWhatsAppMessage({
				to: from,
				body: "Please reply with one of the available times (e.g. 2:30 PM)."
			});
			return { handled: true };
		}
		const updated = mergeDraft(session, { timeHHmm: picked, awaiting: null, lastMessage: text });
		setSession(from, updated);
		return finishBooking(from, updated);
	}

	let parsed = await parseAppointmentIntentFromText({ text });
	if (parsed.intent === "other" && looksLikeAppointmentRequest(text)) {
		parsed = { ...parsed, intent: "book_appointment" };
	}

	if (parsed.intent === "cancel_appointment") {
		await sendWhatsAppMessage({
			to: from,
			body: "To cancel an appointment, please call the clinic or use the CRM calendar. We can add WhatsApp cancel soon."
		});
		setSession(from, clearAppointmentFlow(session));
		return { handled: true };
	}

	if (parsed.intent === "reschedule_appointment") {
		const name = parsed.patientName || extractPatientNameFallback(text) || draft.patientName;
		if (!name) {
			setSession(from, mergeDraft(session, { intent: "reschedule" }));
			await sendWhatsAppMessage({
				to: from,
				body: "To reschedule, please share the patient name and the new preferred date and time."
			});
			return { handled: true };
		}
		const patient = await findPatientByName(name);
		if (!patient) {
			logCrm("appointment_patient_not_found", { patientName: name });
			await sendWhatsAppMessage({ to: from, body: CRM_ERRORS.PATIENT_NOT_FOUND });
			return { handled: true };
		}
		const { dateIso, timeHHmm } = parseNaturalDateTime(text);
		if (!dateIso || !timeHHmm) {
			setSession(
				from,
				mergeDraft(session, {
					intent: "reschedule",
					patientId: patient.id,
					patientName: patient.name,
					reschedulePatientId: patient.id
				})
			);
			await sendWhatsAppMessage({
				to: from,
				body: `Found ${patient.name}. What is the new date and time?`
			});
			return { handled: true };
		}
		return rescheduleExisting(from, patient, dateIso, timeHHmm, parsed.clinician || draft.clinician);
	}

	const natural = parseNaturalDateTime(text);
	const eveningTime = eveningToHHmm(text);
	const patientName =
		parsed.patientName || extractPatientNameFallback(text) || draft.patientName || null;
	const dateIso = parsed.dueDate || natural.dateIso || draft.dateIso || null;
	const timeHHmm = parsed.dueTime || natural.timeHHmm || eveningTime || draft.timeHHmm || null;
	const kind = inferKindFromText(text, parsed.appointmentKind || draft.kind);
	const clinician = parsed.clinician || draft.clinician || DEFAULT_CLINICIAN;
	const location = parsed.location || draft.location || DEFAULT_LOCATION;
	const treatment = parsed.treatmentOrService || draft.treatmentLabel || null;

	let nextSession = mergeDraft(session, {
		patientName,
		dateIso,
		timeHHmm,
		kind,
		clinician,
		location,
		treatmentLabel: treatment,
		notes: parsed.notes || draft.notes,
		lastMessage: text
	});

	if (patientName && !nextSession.appointmentDraft.patientId) {
		const patient = await findPatientByName(patientName);
		if (patient) {
			nextSession = mergeDraft(nextSession, {
				patientId: patient.id,
				patientName: patient.name,
				ownerId: resolveCrmOwnerId(patient)
			});
		}
	}

	setSession(from, nextSession);
	const d = nextSession.appointmentDraft;

	const missing = nextMissingField(d);
	if (missing) {
		if (d.patientName && !d.patientId) {
			logCrm("appointment_patient_not_found", { patientName: d.patientName });
			await sendWhatsAppMessage({ to: from, body: CRM_ERRORS.PATIENT_NOT_FOUND });
			return { handled: true };
		}
		if (missing === "date" || missing === "time") {
			await sendWhatsAppMessage({ to: from, body: CRM_ERRORS.MISSING_APPOINTMENT_DATETIME });
			return { handled: true };
		}
		await sendWhatsAppMessage({ to: from, body: askForField(missing) });
		return { handled: true };
	}

	return finishBooking(from, nextSession);
}

async function finishBooking(from, session) {
	const d = session.appointmentDraft || {};
	const patientId = d.patientId;
	const patientName = d.patientName;

	if (!patientId) {
		logCrm("appointment_patient_not_found", { patientName });
		logCrmDebugSummary({
			patientFound: false,
			appointmentCreated: false,
			reason: "missing_patient_id"
		});
		await sendWhatsAppMessage({ to: from, body: CRM_ERRORS.PATIENT_NOT_FOUND });
		return { handled: true };
	}

	const { data: patientRow } = await supabase
		.from("patients")
		.select("id, name, owner_id")
		.eq("id", patientId)
		.maybeSingle();

	const ownerId = resolveCrmOwnerId(patientRow || { id: patientId, owner_id: d.ownerId });

	if (patientRow?.owner_id && ownerId && String(patientRow.owner_id) !== String(ownerId)) {
		logCrm("owner_patient_mismatch", {
			patientId,
			patientOwnerId: patientRow.owner_id,
			resolvedOwnerId: ownerId
		});
	}

	if (!ownerId) {
		logCrmDebugSummary({
			patientFound: true,
			patientId,
			appointmentCreated: false,
			reason: "missing_owner_id"
		});
		await sendWhatsAppMessage({
			to: from,
			body: "Unable to create the appointment. Please try again."
		});
		return { handled: true };
	}

	if (!isSlotWithinBusinessHours(d.dateIso, d.timeHHmm)) {
		await sendWhatsAppMessage({
			to: from,
			body: "That time is outside clinic hours (Mon–Sat 10:00 AM – 8:00 PM). Please choose another time."
		});
		return { handled: true };
	}

	const { scheduled_at: scheduledAt, ends_at: endsAt } = buildAppointmentRange(
		d.dateIso,
		d.timeHHmm,
		DEFAULT_DURATION_MIN
	);

	const dup = await findVisiblePatientDuplicate(supabase, {
		ownerId,
		patientId,
		scheduledAt,
		endsAt
	});
	if (dup.blocking && dup.row) {
		const when = formatShortDateTime(dup.row.scheduled_at).combined;
		await sendWhatsAppMessage({
			to: from,
			body: `This patient already has an appointment at ${when}.\n\nAppointment ID: ${dup.row.id}\n\nYou can find it in DermaplastCRM under Appointments for that date.`
		});
		return { handled: true };
	}

	const { rows: conflicts } = await findVisibleSlotConflicts(supabase, {
		ownerId,
		scheduledAt,
		endsAt,
		clinician: d.clinician
	});

	if (conflicts.length) {
		const slots = await suggestAvailableSlots(supabase, {
			ownerId,
			dateIso: d.dateIso,
			preferredTimeHHmm: d.timeHHmm,
			clinician: d.clinician
		});
		const lines = slots.map((s) => formatTimeOnly(s.scheduled_at));
		const { timePart } = formatShortDateTime(scheduledAt);
		const msg =
			lines.length > 0
				? `❌ ${timePart} is already booked.\n\nAvailable slots:\n${lines.map((l) => `• ${l}`).join("\n")}\n\nReply with your preferred slot.`
				: `❌ ${timePart} is already booked. No other slots that day — please try another date.`;

		setSession(
			from,
			mergeDraft(session, {
				awaiting: "slot_choice",
				suggestedSlots: slots.map((s) => s.scheduled_at)
			})
		);
		await sendWhatsAppMessage({ to: from, body: msg });
		return { handled: true };
	}

	const notes = [d.treatmentLabel, d.notes].filter(Boolean).join(" — ") || null;
	const clinician = d.clinician || DEFAULT_CLINICIAN;
	const payload = {
		owner_id: patientRow?.owner_id ? String(patientRow.owner_id) : ownerId,
		patient_id: patientId,
		patient_name: patientName,
		scheduled_at: scheduledAt,
		ends_at: endsAt,
		kind: d.kind || "consultation",
		status: "scheduled",
		clinician,
		doctor_name: clinician,
		location: d.location,
		notes: notes || d.lastMessage || null
	};

	const insertResult = await insertAppointmentVerified(payload);

	if (!insertResult.ok || !insertResult.record?.id) {
		logCrmDebugSummary({
			patientFound: true,
			patientId,
			patientName,
			ownerId,
			appointmentCreated: false,
			appointmentId: null,
			databaseError: insertResult.error?.message || "unknown",
			doctorName: clinician
		});
		await sendWhatsAppMessage({
			to: from,
			body: "Unable to create appointment. Database insertion failed."
		});
		return { handled: true };
	}

	const verified = insertResult.record;
	const successMsg = formatAppointmentSuccessMessage(
		verified.patient_name || patientName,
		verified.scheduled_at
	);
	await sendWhatsAppMessage({ to: from, body: successMsg });
	logCrmDebugSummary({
		patientFound: true,
		patientId: verified.patient_id,
		patientName: verified.patient_name || patientName,
		ownerId: verified.owner_id,
		doctorName: verified.doctor_name || clinician,
		appointmentCreated: true,
		appointmentId: verified.id,
		scheduledAt: verified.scheduled_at,
		endsAt: verified.ends_at,
		status: verified.status,
		kind: verified.kind
	});
	console.log("[appointmentHandler] booked", {
		id: verified.id,
		patientId: verified.patient_id,
		scheduledAt: verified.scheduled_at
	});
	setSession(from, clearAppointmentFlow(session));
	return { handled: true };
}

async function rescheduleExisting(from, patient, dateIso, timeHHmm, clinician) {
	const ownerId = resolveCrmOwnerId(patient);
	if (!ownerId) {
		await sendWhatsAppMessage({ to: from, body: CRM_ERRORS.APPOINTMENT_CREATE_FAILED });
		return { handled: true };
	}
	const { scheduled_at: scheduledAt, ends_at: endsAt } = buildAppointmentRange(
		dateIso,
		timeHHmm,
		DEFAULT_DURATION_MIN
	);
	const doc = clinician || DEFAULT_CLINICIAN;

	const { data: existing, error: findErr } = await supabase
		.from("appointments")
		.select("id, scheduled_at")
		.eq("owner_id", ownerId)
		.eq("patient_id", patient.id)
		.eq("status", "scheduled")
		.gte("scheduled_at", new Date().toISOString())
		.order("scheduled_at", { ascending: true })
		.limit(1);

	if (findErr || !existing?.length) {
		await sendWhatsAppMessage({
			to: from,
			body: `No upcoming appointment found for ${patient.name}. Reply with full booking details to create one.`
		});
		return { handled: true };
	}

	const apptId = existing[0].id;
	const { rows: conflicts } = await findConflictingAppointments(supabase, {
		ownerId,
		scheduledAt,
		endsAt,
		clinician: doc,
		excludeId: apptId
	});

	if (conflicts.length) {
		const { timePart } = formatShortDateTime(scheduledAt);
		await sendWhatsAppMessage({ to: from, body: `❌ ${timePart} is not available. Please pick another time.` });
		return { handled: true };
	}

	const { error } = await supabase
		.from("appointments")
		.update({
			scheduled_at: scheduledAt,
			ends_at: endsAt,
			doctor_name: doc,
			clinician: doc
		})
		.eq("id", apptId);

	if (error) {
		await sendWhatsAppMessage({ to: from, body: `Reschedule failed: ${error.message}` });
		return { handled: true };
	}

	const { datePart, timePart } = formatShortDateTime(scheduledAt);
	await sendWhatsAppMessage({
		to: from,
		body: `✅ Appointment rescheduled for ${patient.name} on ${datePart} at ${timePart}.`
	});
	setSession(from, clearAppointmentFlow(getSession(from)));
	return { handled: true };
}
