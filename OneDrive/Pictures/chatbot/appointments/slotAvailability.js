import { isWithinBusinessHours } from "../bizHours.js";
import { getClinicTimezone } from "../clinicTimezone.js";
import { clinicLocalToUtcIso } from "../crm/datetime.js";
import { findVisibleSlotConflicts } from "../crm/appointmentQueries.js";

const DEFAULT_DURATION_MIN = Number(process.env.APPOINTMENT_DURATION_MINUTES || 30);
const SLOT_STEP_MIN = Number(process.env.APPOINTMENT_SLOT_STEP_MINUTES || 30);
const MAX_SUGGESTIONS = Number(process.env.APPOINTMENT_MAX_SLOT_SUGGESTIONS || 5);

function getClinicTz() {
	return getClinicTimezone();
}

/** Default Mon–Sat 10:00–20:00 if env JSON not set */
function getDayHours(date, tz) {
	const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(date);
	const dayKey = weekday.slice(0, 3);
	const raw = String(process.env.CLINIC_BUSINESS_HOURS_JSON || "").trim();
	if (raw) {
		try {
			const cfg = JSON.parse(raw);
			const day = cfg[dayKey];
			if (day?.open && day?.close) {
				const [oh, om] = String(day.open).split(":").map(Number);
				const [ch, cm] = String(day.close).split(":").map(Number);
				return { openMin: oh * 60 + (om || 0), closeMin: ch * 60 + (cm || 0) };
			}
		} catch {
			// fall through
		}
	}
	if (dayKey === "Sun") return null;
	return { openMin: 10 * 60, closeMin: 20 * 60 };
}

/** Clinic wall-clock → UTC (same as CRM booking / buildAppointmentRange). */
function buildScheduledRange(dateIso, timeHHmm, durationMin) {
	const scheduled_at = clinicLocalToUtcIso(dateIso, timeHHmm);
	const ends_at = new Date(new Date(scheduled_at).getTime() + durationMin * 60 * 1000).toISOString();
	return { scheduled_at, ends_at };
}

/** Overlap check — only appointments visible in CRM calendar (same as list/calendar fetch). */
export async function findConflictingAppointments(supabase, { ownerId, scheduledAt, endsAt, excludeId, clinician }) {
	const { rows } = await findVisibleSlotConflicts(supabase, {
		ownerId,
		scheduledAt,
		endsAt,
		excludeId,
		clinician
	});
	return { error: null, rows };
}

export function isSlotWithinBusinessHours(dateIso, timeHHmm, tz = getClinicTz()) {
	const [y, m, d] = dateIso.split("-").map(Number);
	const ref = new Date(y, m - 1, d, 12, 0, 0);
	const hours = getDayHours(ref, tz);
	if (!hours) return false;
	const [hh, mm] = timeHHmm.split(":").map(Number);
	const mins = hh * 60 + mm;
	return mins >= hours.openMin && mins + DEFAULT_DURATION_MIN <= hours.closeMin;
}

/**
 * Find up to `limit` free slots on the same calendar day, stepping by SLOT_STEP_MIN.
 */
export async function suggestAvailableSlots(supabase, { ownerId, dateIso, preferredTimeHHmm, clinician, limit = MAX_SUGGESTIONS }) {
	const tz = getClinicTz();
	const hours = getDayHours(new Date(dateIso + "T12:00:00"), tz);
	if (!hours) return [];

	const preferredMins = preferredTimeHHmm
		? (() => {
				const [hh, mm] = preferredTimeHHmm.split(":").map(Number);
				return hh * 60 + mm;
			})()
		: hours.openMin;

	const found = [];
	const duration = DEFAULT_DURATION_MIN;

	for (let m = hours.openMin; m + duration <= hours.closeMin && found.length < limit; m += SLOT_STEP_MIN) {
		const hh = Math.floor(m / 60);
		const mm = m % 60;
		const timeHHmm = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
		const range = buildScheduledRange(dateIso, timeHHmm, duration);
		const { rows } = await findConflictingAppointments(supabase, {
			ownerId,
			scheduledAt: range.scheduled_at,
			endsAt: range.ends_at,
			clinician
		});
		if (!rows.length) {
			found.push({ scheduled_at: range.scheduled_at, ends_at: range.ends_at, timeHHmm });
		}
	}

	// Sort by distance from preferred time
	found.sort((a, b) => {
		const da = Math.abs(parseHHmmToMinutes(a.timeHHmm) - preferredMins);
		const db = Math.abs(parseHHmmToMinutes(b.timeHHmm) - preferredMins);
		return da - db;
	});

	return found.slice(0, limit);
}

function parseHHmmToMinutes(hhmm) {
	const [hh, mm] = hhmm.split(":").map(Number);
	return hh * 60 + mm;
}

export function formatSlotLabel(isoStart, tz = getClinicTz()) {
	const d = new Date(isoStart);
	return d.toLocaleString("en-IN", {
		timeZone: tz,
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "numeric",
		minute: "2-digit",
		hour12: true
	});
}

export function formatShortDateTime(isoStart, tz = getClinicTz()) {
	const d = new Date(isoStart);
	const datePart = d.toLocaleDateString("en-IN", { timeZone: tz, day: "numeric", month: "short" });
	const timePart = d.toLocaleTimeString("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
	return { datePart, timePart, combined: `${datePart} at ${timePart}` };
}

export function formatTimeOnly(isoStart, tz = getClinicTz()) {
	return new Date(isoStart).toLocaleTimeString("en-IN", {
		timeZone: tz,
		hour: "numeric",
		minute: "2-digit",
		hour12: true
	});
}

export { DEFAULT_DURATION_MIN, getClinicTz };
