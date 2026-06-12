import { parseDate } from "chrono-node";
import { supabase } from "../tasks/supabaseClient.js";
import { parseClinicDateTime, buildAppointmentRange } from "../crm/datetime.js";
import {
	findPatientByContact,
	createPatientRecord,
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

const MOBILE_SEGMENT_REGEX = /(\+?\d[\d\s\-()]{8,}\d)/g;

function normalizePhoneDigits(candidate) {
	if (!candidate) return null;
	const digits = String(candidate || "")
		.replace(/[^\d]+/g, "")
		.replace(/^0+/, "");
	if (digits.length === 10) return digits;
	if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
	if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
	return null;
}

function extractMobileFromText(text) {
	if (!text) return null;
	const matches = Array.from(String(text).matchAll(MOBILE_SEGMENT_REGEX), (m) => m[1]);
	for (const match of matches) {
		const normalized = normalizePhoneDigits(match);
		if (normalized) return normalized;
	}
	return null;
}

function extractEmailFromText(text) {
	if (!text) return null;
	const match = String(text).match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
	return match ? match[0].toLowerCase() : null;
}

function detectGenderFromText(text) {
	if (!text) return null;
	const normalized = String(text).toLowerCase();
	if (/\b(male|man|m)\b/.test(normalized)) return "male";
	if (/\b(female|woman|f)\b/.test(normalized)) return "female";
	if (/\b(non[-\s]?binary|nb|other)\b/.test(normalized)) return "other";
	return null;
}

async function resolveOwnerIdForNewPatient(ownerOverride) {
	if (ownerOverride) return ownerOverride;
	if (DEFAULT_OWNER_ID) return DEFAULT_OWNER_ID;

	try {
		const { data } = await supabase
			.from("patients")
			.select("owner_id")
			.not("owner_id", "is", null)
			.order("updated_at", { ascending: false })
			.limit(1);
		const ownerId = (data || [])[0]?.owner_id || null;
		if (ownerId) return String(ownerId);
	} catch (err) {
		console.warn("[appointmentHandler] owner lookup failed", err?.message || err);
	}
	return null;
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
	if (!draft.mobile) return "mobile";
	if (!draft.patientName && !draft.patientId) return "patientName";
	if (!draft.treatmentLabel) return "treatment";
	if (!draft.dateIso) return "date";
	if (!draft.timeHHmm) return "time";
	return null;
}

function askForField(field) {
	const prompts = {
		mobile: "Please enter your mobile number (10 digits).",
		patientName: "Please share the patient's full name as it appears in our records.",
		treatment: "What treatment or service are you looking for? (e.g. PRP, consultation, hair transplant).",
		date: "Which date would you like? (e.g. tomorrow, 23 May, next Monday)",
		time: "What time works best? (e.g. 2 PM, 5:30 PM, evening)"
	};
	return prompts[field] || "Please share a few more details to book the appointment.";
}

function existingCustomerIntro(name) {
	const displayName = String(name || "there").split(" ").slice(0, 2).join(" ").trim();
	return `Welcome back ${displayName}. I found your details.`;
}

function newCustomerIntro() {
	return "I couldn't find your profile. Let's create your appointment.";
}

function looksLikeGeneralInquiry(text) {
	const t = String(text || "").toLowerCase();
	if (!t.trim()) return false;
	if (t.endsWith("?")) return true;
	return /\b(where|what|when|how|why|which|who)\b/.test(t);
}

function fulfillsFieldHint(field, text) {
	if (!text) return false;
	const trimmed = text.trim();
	if (!trimmed) return false;
	switch (field) {
		case "mobile":
			return Boolean(extractMobileFromText(trimmed));
		case "patientName":
			return trimmed.split(/\s+/).length >= 2 && /\D{2,}/.test(trimmed);
		case "treatment":
			return /\b(treatment|consultation|prp|laser|facial|hair|skin|service)\b/i.test(trimmed);
		case "date":
			return Boolean(parseNaturalDateTime(trimmed)?.dateIso);
		case "time":
			return Boolean(parseTimeOnly(trimmed, parseNaturalDateTime(trimmed)?.dateIso || trimmed));
		default:
			return false;
	}
}

async function promptForField(from, field, session, outboundFrom) {
	const draft = session.appointmentDraft || {};
	const prefix = draft.customerIntro;
	const question = askForField(field);
	const body = prefix ? `${prefix}\n\n${question}` : question;
	await sendWhatsAppMessage({ to: from, body, from: outboundFrom });
	const updatedSession = mergeDraft(session, { customerIntro: null, awaitingField: field });
	setSession(from, updatedSession);
}

async function enrichSessionWithPatient(session) {
	const draft = session.appointmentDraft || {};
	if (draft.patientId || draft.customerLookupState === "found") {
		return session;
	}
	if (draft.customerLookupState != null) {
		return session;
	}

	let patient = null;
	let attemptedLookup = false;
	if (draft.mobile || draft.email) {
		patient = await findPatientByContact({ phone: draft.mobile, email: draft.email });
		attemptedLookup = true;
	}
	if (!patient && draft.patientName) {
		attemptedLookup = true;
		patient = await findPatientByName(draft.patientName);
		if (!patient) {
			logCrm("appointment_patient_not_found", { patientName: draft.patientName });
		}
	}

	if (!attemptedLookup) {
		return session;
	}

	if (patient) {
		const intro = draft.customerIntro || existingCustomerIntro(patient.name);
		return mergeDraft(session, {
			patientId: patient.id,
			patientName: patient.name,
			ownerId: resolveCrmOwnerId(patient),
			customerLookupState: "found",
			customerIntro: intro
		});
	}

	const intro = draft.customerIntro || newCustomerIntro();
	return mergeDraft(session, {
		customerLookupState: "not_found",
		newCustomer: true,
		customerIntro: intro
	});
}

async function ensurePatientForDraft(from, session, outboundFrom) {
	const draft = session.appointmentDraft || {};
	if (!draft.patientName || !draft.mobile) {
		await sendWhatsAppMessage({
			to: from,
			body: "Please provide the patient's full name and mobile number so we can register them.",
			from: outboundFrom
		});
		return { success: false };
	}

	const ownerId = await resolveOwnerIdForNewPatient(draft.ownerId || null);
	if (!ownerId) {
		logCrm("appointment_patient_create_failed", { reason: "missing_owner_id" });
		await sendWhatsAppMessage({ to: from, body: CRM_ERRORS.CREATE_FAILED, from: outboundFrom });
		return { success: false };
	}

	const creation = await createPatientRecord({
		name: draft.patientName,
		phone: draft.mobile,
		email: draft.email,
		gender: draft.gender,
		treatmentCategory: draft.treatmentLabel,
		ownerId
	});

	if (creation.ok && creation.record) {
		const updatedSession = mergeDraft(session, {
			patientId: creation.record.id,
			patientName: creation.record.name,
			ownerId: creation.record.owner_id,
			customerLookupState: "found"
		});
		setSession(from, updatedSession);
		return { success: true, session: updatedSession };
	}

	if (creation.duplicate) {
		const existing = await findPatientByContact({ phone: draft.mobile, email: draft.email });
		if (existing) {
			const updatedSession = mergeDraft(session, {
				patientId: existing.id,
				patientName: existing.name,
				ownerId: resolveCrmOwnerId(existing),
				customerLookupState: "found"
			});
			setSession(from, updatedSession);
			return { success: true, session: updatedSession };
		}
	}

	logCrm("appointment_patient_create_failed", {
		ownerId,
		error: creation.error?.message,
		duplicate: creation.duplicate
	});
	await sendWhatsAppMessage({ to: from, body: CRM_ERRORS.CREATE_FAILED, from: outboundFrom });
	return { success: false };
}

/**
 * @returns {Promise<{ handled: boolean }>}
 */
export async function handleAppointmentBookingFromWhatsApp({ from, body, outboundFrom }) {
	const text = String(body || "").trim();
	if (!text) return { handled: false };

	const session = getSession(from);
	const inFlow = session.flow === FLOW;
	const draft = session.appointmentDraft || {};

	if (inFlow && draft.awaitingField && looksLikeGeneralInquiry(text) && !fulfillsFieldHint(draft.awaitingField, text)) {
		setSession(from, clearAppointmentFlow(session));
		return { handled: false };
	}

	if (inFlow && !draft.awaitingField && looksLikeGeneralInquiry(text)) {
		setSession(from, clearAppointmentFlow(session));
		return { handled: false };
	}

	if (!inFlow && !looksLikeAppointmentRequest(text) && !isExplicitCrmAppointmentCommand(text)) {
		return { handled: false };
	}

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

	if (inFlow && draft.awaiting === "slot_choice" && draft.dateIso) {
		const picked = parseTimeOnly(text, draft.dateIso) || parseNaturalDateTime(`${draft.dateIso} ${text}`).timeHHmm;
		if (!picked) {
			await sendWhatsAppMessage({
				to: from,
				body: "Please reply with one of the available times (e.g. 2:30 PM).",
				from: outboundFrom
			});
			return { handled: true };
		}
		const updated = mergeDraft(session, { timeHHmm: picked, awaiting: null, lastMessage: text });
		setSession(from, updated);
		return finishBooking(from, updated, outboundFrom);
	}

	let parsed = await parseAppointmentIntentFromText({ text });
	if (parsed.intent === "other" && looksLikeAppointmentRequest(text)) {
		parsed = { ...parsed, intent: "book_appointment" };
	}

	if (parsed.intent === "reschedule_appointment" && !RESCHEDULE_KEYWORDS.test(text)) {
		parsed = { ...parsed, intent: "book_appointment" };
	}

	if (parsed.intent === "cancel_appointment") {
		await sendWhatsAppMessage({
			to: from,
			body: "To cancel an appointment, please call the clinic or use the CRM calendar. We can add WhatsApp cancel soon.",
			from: outboundFrom
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
				body: "To reschedule, please share the patient name and the new preferred date and time.",
				from: outboundFrom
			});
			return { handled: true };
		}
		const patient = await findPatientByName(name);
		if (!patient) {
			logCrm("appointment_patient_not_found", { patientName: name });
			await sendWhatsAppMessage({ to: from, body: CRM_ERRORS.PATIENT_NOT_FOUND, from: outboundFrom });
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
				body: `Found ${patient.name}. What is the new date and time?`,
				from: outboundFrom
			});
			return { handled: true };
		}
		return rescheduleExisting(from, patient, dateIso, timeHHmm, parsed.clinician || draft.clinician, outboundFrom);
	}

	const natural = parseNaturalDateTime(text);
	const eveningTime = eveningToHHmm(text);
	const patientName =
		parsed.patientName || extractPatientNameFallback(text) || draft.patientName || null;
	const dateIso = parsed.dueDate || natural.dateIso || draft.dateIso || null;
	const timeHHmm = parsed.dueTime || natural.timeHHmm || eveningTime || draft.timeHHmm || null;
	const kind = inferKindFromText(text, parsed.appointmentKind || draft.kind);
	const clinician = parsed.clinician || draft.clinician || null;
	const location = parsed.location || draft.location || DEFAULT_LOCATION;
	const treatment = parsed.treatmentOrService || draft.treatmentLabel || null;
	const mobileCandidate = extractMobileFromText(text);
	const whatsappMobileFrom = extractMobileFromText(from);
	const emailCandidate = extractEmailFromText(text);
	const genderCandidate = detectGenderFromText(text);

	const patch = {
		patientName,
		dateIso,
		timeHHmm,
		kind,
		clinician,
		location,
		treatmentLabel: treatment,
		notes: parsed.notes || draft.notes,
		lastMessage: text,
		awaitingField: null
	};

	let resetLookup = false;
	// Seed mobile from the WhatsApp sender number so we can skip registration
	// for existing customers.
	if (!mobileCandidate && whatsappMobileFrom && whatsappMobileFrom !== draft.mobile) {
		patch.mobile = whatsappMobileFrom;
		resetLookup = true;
	}

	if (mobileCandidate && mobileCandidate !== draft.mobile) {
		patch.mobile = mobileCandidate;
		resetLookup = true;
	}
	if (emailCandidate && emailCandidate !== draft.email) {
		patch.email = emailCandidate;
		resetLookup = true;
	}
	if (genderCandidate && genderCandidate !== draft.gender) {
		patch.gender = genderCandidate;
	}
	if (patientName && patientName !== draft.patientName) {
		resetLookup = true;
	}
	if (resetLookup) {
		patch.customerLookupState = null;
	}

	const nextSession = mergeDraft(session, patch);
	const enriched = await enrichSessionWithPatient(nextSession);
	setSession(from, enriched);

	const missing = nextMissingField(enriched.appointmentDraft);
	if (missing) {
		await promptForField(from, missing, enriched, outboundFrom);
		return { handled: true };
	}

	return finishBooking(from, enriched, outboundFrom);
}

async function finishBooking(from, session, outboundFrom) {
	let workingSession = session;
	let d = workingSession.appointmentDraft || {};

	if (!d.patientId) {
		const ensure = await ensurePatientForDraft(from, workingSession, outboundFrom);
		if (!ensure.success) return { handled: true };
		workingSession = ensure.session;
		d = workingSession.appointmentDraft || {};
	}

	const patientId = d.patientId;
	const patientName = d.patientName;

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
			body: "Unable to create the appointment. Please try again.",
			from: outboundFrom
		});
		return { handled: true };
	}

	if (!isSlotWithinBusinessHours(d.dateIso, d.timeHHmm)) {
		await sendWhatsAppMessage({
			to: from,
			body: "That time is outside clinic hours (Mon–Sat 10:00 AM – 8:00 PM). Please choose another time.",
			from: outboundFrom
		});
		return { handled: true };
	}

	const { scheduled_at: scheduledAt, ends_at: endsAt } = buildAppointmentRange(
		d.dateIso,
		d.timeHHmm,
		DEFAULT_DURATION_MIN
	);

	const scheduledDate = new Date(scheduledAt);
	if (scheduledDate <= new Date()) {
		await sendWhatsAppMessage({
			to: from,
			body: "Appointment date cannot be in the past. Please choose another date.",
			from: outboundFrom
		});
		return { handled: true };
	}

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
				body: `This patient already has an appointment at ${when}.\n\nAppointment ID: ${dup.row.id}\n\nYou can find it in DermaplastCRM under Appointments for that date.`,
				from: outboundFrom
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

		workingSession = mergeDraft(workingSession, {
			awaiting: "slot_choice",
			suggestedSlots: slots.map((s) => s.scheduled_at)
		});
		setSession(from, workingSession);
		await sendWhatsAppMessage({ to: from, body: msg, from: outboundFrom });
		return { handled: true };
	}

	const optionalBits = [];
	if (d.email) optionalBits.push(`Email: ${d.email}`);
	if (d.gender) optionalBits.push(`Gender: ${d.gender}`);
	const notes = [d.treatmentLabel, d.notes, optionalBits.join(", ")].filter(Boolean).join(" — ") || null;
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
			body: "Unable to create appointment. Database insertion failed.",
			from: outboundFrom
		});
		return { handled: true };
	}

	const verified = insertResult.record;
	const successMsg = formatAppointmentSuccessMessage(
		verified.patient_name || patientName,
		verified.scheduled_at
	);
	await sendWhatsAppMessage({ to: from, body: successMsg, from: outboundFrom });
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
	setSession(from, clearAppointmentFlow(workingSession));
	return { handled: true };
}

async function rescheduleExisting(from, patient, dateIso, timeHHmm, clinician, outboundFrom) {
	const ownerId = resolveCrmOwnerId(patient);
	if (!ownerId) {
		await sendWhatsAppMessage({ to: from, body: CRM_ERRORS.APPOINTMENT_CREATE_FAILED, from: outboundFrom });
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
			body: `No upcoming appointment found for ${patient.name}. Reply with full booking details to create one.`,
			from: outboundFrom
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
		await sendWhatsAppMessage({ to: from, body: `❌ ${timePart} is not available. Please pick another time.`, from: outboundFrom });
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
		await sendWhatsAppMessage({ to: from, body: `Reschedule failed: ${error.message}`, from: outboundFrom });
		return { handled: true };
	}

	const { datePart, timePart } = formatShortDateTime(scheduledAt);
	await sendWhatsAppMessage({
		to: from,
		body: `✅ Appointment rescheduled for ${patient.name} on ${datePart} at ${timePart}.`,
		from: outboundFrom
	});
	setSession(from, clearAppointmentFlow(getSession(from)));
	return { handled: true };
}
