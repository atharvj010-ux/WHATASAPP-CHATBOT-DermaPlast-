/**
 * Appointment reads aligned with DermaplastCRM calendar/list (fetchOwnerAppointmentsInRange).
 */
import { dateKeyInClinicTz, dayBoundsInClinicTz } from "./datetime.js";
import { getClinicTimezone } from "../clinicTimezone.js";
import { logCrm } from "./crmIntegration.js";

/** Statuses that block new bookings — matches active calendar slots (not cancelled/completed). */
export const CRM_BLOCKING_STATUSES = ["scheduled"];

const APPT_SELECT =
	"id,owner_id,patient_id,patient_name,scheduled_at,ends_at,status,kind,doctor_name,clinician,location,notes";

/**
 * Same query shape as lib/appointments/fetch-appointments.ts fetchOwnerAppointmentsInRange.
 */
function assertValidRange(range, context = "") {
	const startMs = range?.start instanceof Date ? range.start.getTime() : NaN;
	const endMs = range?.end instanceof Date ? range.end.getTime() : NaN;
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
		throw new RangeError(`Invalid appointment calendar range${context ? ` (${context})` : ""}`);
	}
}

export async function fetchOwnerAppointmentsInRange(supabase, ownerId, range) {
	assertValidRange(range);
	const { data, error } = await supabase
		.from("appointments")
		.select(APPT_SELECT)
		.eq("owner_id", ownerId)
		.gte("scheduled_at", range.start.toISOString())
		.lt("scheduled_at", range.end.toISOString())
		.order("scheduled_at", { ascending: true });

	return { data: data ?? [], error };
}

export function calendarRangeForScheduledAt(scheduledAtIso, timeZone = getClinicTimezone()) {
	const instant = new Date(scheduledAtIso);
	if (Number.isNaN(instant.getTime())) {
		throw new RangeError(`Invalid scheduled_at: ${scheduledAtIso}`);
	}
	const dateKey = dateKeyInClinicTz(instant, timeZone);
	return { dateKey, ...dayBoundsInClinicTz(dateKey, timeZone) };
}

const DEFAULT_SLOT_MIN = Number(process.env.APPOINTMENT_DURATION_MINUTES || 30);

/** Overlap: existing.start < newEnd AND existing.end > newStart */
export function appointmentOverlapsRange(row, scheduledAt, endsAt) {
	const reqStart = new Date(scheduledAt).getTime();
	const reqEnd = new Date(endsAt).getTime();
	if (!Number.isFinite(reqStart) || !Number.isFinite(reqEnd)) return false;

	const start = new Date(row.scheduled_at).getTime();
	if (!Number.isFinite(start)) return false;

	const end = row.ends_at
		? new Date(row.ends_at).getTime()
		: start + DEFAULT_SLOT_MIN * 60 * 1000;
	if (!Number.isFinite(end)) return start >= reqStart && start < reqEnd;

	return start < reqEnd && end > reqStart;
}

/** Load appointments for the clinic calendar day (same query as CRM UI). */
export async function fetchCalendarDayAppointments(supabase, ownerId, scheduledAtIso) {
	const range = calendarRangeForScheduledAt(scheduledAtIso);
	const { data, error } = await fetchOwnerAppointmentsInRange(supabase, ownerId, range);
	if (error) throw error;
	return { range, rows: data ?? [] };
}

export function logAppointmentConflictDebug(event, row, extra = {}) {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "appointment-conflict-debug",
			event,
			sourceTable: "public.appointments",
			appointmentId: row?.id ?? null,
			patientId: row?.patient_id ?? null,
			organizationId: row?.owner_id ?? null,
			appointmentDate: row?.scheduled_at ? dateKeyInClinicTz(new Date(row.scheduled_at)) : null,
			startTime: row?.scheduled_at ?? null,
			endTime: row?.ends_at ?? null,
			status: row?.status ?? null,
			deletedFlag: false,
			doctorId: row?.doctor_name ?? row?.clinician ?? null,
			kind: row?.kind ?? null,
			...extra
		})
	);
}

/**
 * Patient duplicate at same time — only if record is visible via CRM calendar query.
 * @returns {Promise<{ blocking: boolean, row: object | null, reason: string }>}
 */
export async function findVisiblePatientDuplicate(supabase, { ownerId, patientId, scheduledAt, endsAt }) {
	try {
		const { rows } = await fetchCalendarDayAppointments(supabase, ownerId, scheduledAt);
		const candidates = rows.filter(
			(row) =>
				row.patient_id === patientId &&
				CRM_BLOCKING_STATUSES.includes(String(row.status || "").toLowerCase()) &&
				appointmentOverlapsRange(row, scheduledAt, endsAt)
		);

		if (!candidates.length) {
			return { blocking: false, row: null, reason: "none" };
		}

		const row = candidates[0];
		logAppointmentConflictDebug("visible_duplicate_patient_slot", row, {
			requestedStart: scheduledAt,
			requestedEnd: endsAt
		});
		return { blocking: true, row, reason: "visible_in_crm" };
	} catch (e) {
		logCrm("duplicate_check_error", { message: e?.message || String(e) });
		return { blocking: false, row: null, reason: "query_error" };
	}
}

/**
 * Slot conflict for any patient — same visibility rule as calendar.
 */
export async function findVisibleSlotConflicts(
	supabase,
	{ ownerId, scheduledAt, endsAt, excludeId, clinician }
) {
	try {
		const { rows } = await fetchCalendarDayAppointments(supabase, ownerId, scheduledAt);
		const clinicianNeedle = clinician?.trim().toLowerCase();

		const visible = rows.filter((row) => {
			if (excludeId && row.id === excludeId) return false;
			if (!CRM_BLOCKING_STATUSES.includes(String(row.status || "").toLowerCase())) return false;
			if (!appointmentOverlapsRange(row, scheduledAt, endsAt)) return false;
			if (clinicianNeedle) {
				const doc = String(row.doctor_name || row.clinician || "").toLowerCase();
				if (!doc.includes(clinicianNeedle)) return false;
			}
			return true;
		});

		for (const row of visible) {
			logAppointmentConflictDebug("visible_slot_conflict", row, {
				requestedStart: scheduledAt,
				requestedEnd: endsAt
			});
		}

		return { rows: visible, hidden: [] };
	} catch (e) {
		logCrm("slot_conflict_query_error", { message: e?.message || String(e) });
		return { rows: [], hidden: [] };
	}
}
