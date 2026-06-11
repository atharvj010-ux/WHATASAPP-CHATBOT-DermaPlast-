import { supabase } from "../tasks/supabaseClient.js";
import { logCrm } from "./crmIntegration.js";
import {
	calendarRangeForScheduledAt,
	fetchOwnerAppointmentsInRange,
	fetchCalendarDayAppointments
} from "./appointmentQueries.js";

/**
 * Resolve owner_id for CRM writes. Must match patient.owner_id so RLS + calendar/list/history match.
 * SUPABASE_DEFAULT_OWNER_ID is only used for patient lookup scoping, not to override the patient owner.
 */
export function resolveCrmOwnerId(patient) {
	const fromPatient = patient?.owner_id ? String(patient.owner_id) : "";
	const fromEnv = String(process.env.SUPABASE_DEFAULT_OWNER_ID || "").trim();

	if (fromPatient) {
		if (fromEnv && fromPatient !== fromEnv) {
			logCrm("owner_id_using_patient", {
				patientId: patient?.id,
				patientOwnerId: fromPatient,
				envOwnerId: fromEnv,
				note: "Appointment will use patient owner_id so CRM UI can display it"
			});
		}
		return fromPatient;
	}

	return fromEnv || null;
}

/**
 * Insert appointment and confirm row exists (service role).
 */
export async function insertAppointmentVerified(payload) {
	logCrm("appointment_insert_attempt", {
		owner_id: payload.owner_id,
		patient_id: payload.patient_id,
		patient_name: payload.patient_name,
		scheduled_at: payload.scheduled_at,
		ends_at: payload.ends_at,
		kind: payload.kind,
		doctor_name: payload.doctor_name
	});

	const { data, error } = await supabase
		.from("appointments")
		.insert(payload)
		.select("id, owner_id, patient_id, patient_name, scheduled_at, ends_at, status, kind, doctor_name")
		.single();

	if (error) {
		logCrm("appointment_insert_error", {
			message: error.message,
			code: error.code,
			details: error.details,
			hint: error.hint
		});
		return { ok: false, error, record: null };
	}

	if (!data?.id) {
		logCrm("appointment_insert_no_row", { payload });
		return { ok: false, error: { message: "Insert returned no row" }, record: null };
	}

	const ownerId = payload.owner_id;

	const { data: verified, error: verifyErr } = await supabase
		.from("appointments")
		.select(
			"id, owner_id, patient_id, scheduled_at, ends_at, status, kind, doctor_name, patient_name, clinician"
		)
		.eq("id", data.id)
		.eq("owner_id", ownerId)
		.maybeSingle();

	if (verifyErr || !verified) {
		logCrm("appointment_verify_failed", {
			appointmentId: data.id,
			ownerId,
			error: verifyErr?.message || "not found for owner after insert"
		});
		return {
			ok: false,
			error: verifyErr || { message: "Appointment not found for clinic owner after insert" },
			record: null
		};
	}

	let visibleInCalendar = false;
	let rangeErr = null;
	try {
		const { rows: inRangeRows } = await fetchCalendarDayAppointments(
			supabase,
			ownerId,
			verified.scheduled_at
		);
		visibleInCalendar = inRangeRows.some((r) => r.id === verified.id);
	} catch (e) {
		rangeErr = e;
	}

	if (rangeErr || !visibleInCalendar) {
		const calendarRange = calendarRangeForScheduledAt(verified.scheduled_at);
		logCrm("appointment_calendar_range_verify_failed", {
			appointmentId: verified.id,
			scheduled_at: verified.scheduled_at,
			rangeStart: calendarRange.start.toISOString(),
			rangeEnd: calendarRange.end.toISOString(),
			dateKey: calendarRange.dateKey,
			error: rangeErr?.message,
			visibleInCalendar
		});
	}

	logCrm("appointment_insert_verified", {
		appointmentId: verified.id,
		owner_id: verified.owner_id,
		patient_id: verified.patient_id,
		scheduled_at: verified.scheduled_at,
		visibleInCalendarQuery: visibleInCalendar
	});

	return { ok: true, error: null, record: verified };
}

/**
 * Insert task and confirm row exists.
 */
export async function insertTaskVerified(payload) {
	logCrm("task_insert_attempt", {
		owner_id: payload.owner_id,
		title: payload.title,
		due_date: payload.due_date,
		project: payload.project,
		linked_entity_id: payload.linked_entity_id
	});

	const { data, error } = await supabase
		.from("tasks")
		.insert(payload)
		.select("id, owner_id, title, due_date, status, project, linked_entity_id")
		.single();

	if (error) {
		logCrm("task_insert_error", {
			message: error.message,
			code: error.code,
			details: error.details
		});
		return { ok: false, error, record: null };
	}

	if (!data?.id) {
		return { ok: false, error: { message: "Insert returned no row" }, record: null };
	}

	const { data: verified, error: verifyErr } = await supabase
		.from("tasks")
		.select("id, owner_id, title, due_date, status, project")
		.eq("id", data.id)
		.maybeSingle();

	if (verifyErr || !verified) {
		logCrm("task_verify_failed", { taskId: data.id, error: verifyErr?.message });
		return {
			ok: false,
			error: verifyErr || { message: "Task not found after insert" },
			record: null
		};
	}

	logCrm("task_insert_verified", {
		taskId: verified.id,
		owner_id: verified.owner_id,
		due_date: verified.due_date
	});

	return { ok: true, error: null, record: verified };
}

/**
 * Find patient by name scoped to CRM owner (matches dashboard .eq("owner_id", uid)).
 */
export async function findPatientForCrm(name) {
	const fragment = String(name || "").trim();
	if (!fragment) return null;

	const ownerId = String(process.env.SUPABASE_DEFAULT_OWNER_ID || "").trim();

	logCrm("patient_lookup_start", { name: fragment, ownerScope: ownerId || "any" });

	let query = supabase
		.from("patients")
		.select("id, name, owner_id, phone")
		.ilike("name", `%${fragment}%`)
		.limit(10);

	if (ownerId) {
		query = query.eq("owner_id", ownerId);
	}

	const { data, error } = await query;
	if (error) {
		logCrm("patient_lookup_error", { message: error.message });
		return null;
	}

	if (!data?.length) {
		logCrm("patient_lookup_not_found", { name: fragment, ownerScope: ownerId || "any" });
		return null;
	}

	const exact = data.find((p) => p.name?.toLowerCase() === fragment.toLowerCase());
	const patient = exact ?? data[0];
	logCrm("patient_lookup_found", {
		patientId: patient.id,
		patientName: patient.name,
		ownerId: patient.owner_id
	});
	return patient;
}

export function logCrmDebugSummary(summary) {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "crm-debug",
			...summary
		})
	);
}
