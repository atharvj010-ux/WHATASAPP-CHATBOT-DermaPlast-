import { parseDate } from "chrono-node";
import { getClinicTimezone } from "../clinicTimezone.js";

const DEFAULT_DURATION_MIN = Number(process.env.APPOINTMENT_DURATION_MINUTES || 30);

function partsInTimeZone(date, timeZone) {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23"
	});
	const parts = dtf.formatToParts(date);
	const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
	return {
		year: get("year"),
		month: get("month"),
		day: get("day"),
		hour: get("hour"),
		minute: get("minute"),
		second: get("second")
	};
}

export function formatDateIsoInTz(date, timeZone = getClinicTimezone()) {
	const p = partsInTimeZone(date, timeZone);
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Calendar date YYYY-MM-DD for an instant in clinic TZ (matches CRM list/calendar). */
export function dateKeyInClinicTz(date, timeZone = getClinicTimezone()) {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).format(date);
}

/** UTC range [start, end) for one clinic calendar day — same as lib/appointments/date-range.ts */
export function dayBoundsInClinicTz(dateKey, timeZone = getClinicTimezone()) {
	const [y, m, d] = dateKey.split("-").map(Number);
	if (!y || !m || !d) {
		const now = new Date();
		return dayBoundsInClinicTz(dateKeyInClinicTz(now, timeZone), timeZone);
	}

	const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
	const p = partsInTimeZone(new Date(noonUtc), timeZone);
	const clinicNoonAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second || 0);
	const offsetMs = clinicNoonAsUtc - noonUtc;
	const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs);
	const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
		const fallback = new Date(Date.UTC(y, m - 1, d));
		const fbEnd = new Date(fallback.getTime() + 24 * 60 * 60 * 1000);
		return { start: fallback, end: fbEnd };
	}
	return { start, end };
}

export function formatTimeHHmmInTz(date, timeZone = getClinicTimezone()) {
	const p = partsInTimeZone(date, timeZone);
	return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/**
 * Convert clinic wall-clock date + time to UTC ISO (for timestamptz columns).
 */
export function clinicLocalToUtcIso(dateIso, timeHHmm, timeZone = getClinicTimezone()) {
	const [year, month, day] = dateIso.split("-").map(Number);
	const [hour, minute] = timeHHmm.split(":").map(Number);

	let ms = Date.UTC(year, month - 1, day, hour, minute, 0);

	for (let i = 0; i < 4; i++) {
		const p = partsInTimeZone(new Date(ms), timeZone);
		const diffMinutes =
			(hour - p.hour) * 60 +
			(minute - p.minute) +
			(day - p.day) * 24 * 60 +
			(month - p.month) * 31 * 24 * 60 +
			(year - p.year) * 365 * 24 * 60;
		if (diffMinutes === 0) break;
		ms += diffMinutes * 60 * 1000;
	}

	return new Date(ms).toISOString();
}

export function buildAppointmentRange(dateIso, timeHHmm, durationMin = DEFAULT_DURATION_MIN) {
	const scheduled_at = clinicLocalToUtcIso(dateIso, timeHHmm);
	const ends_at = new Date(
		new Date(scheduled_at).getTime() + durationMin * 60 * 1000
	).toISOString();
	return { scheduled_at, ends_at };
}

/**
 * Parse natural language date/time in clinic timezone; never return a year in the past.
 */
export function parseClinicDateTime(text, refDate = new Date()) {
	if (!text?.trim()) {
		return { dateIso: null, timeHHmm: null, startIso: null, endsAt: null };
	}

	const tz = getClinicTimezone();
	const parsed = parseDate(text, refDate, { forwardDate: true });
	if (!parsed || Number.isNaN(parsed.getTime())) {
		return { dateIso: null, timeHHmm: null, startIso: null, endsAt: null };
	}

	const nowParts = partsInTimeZone(refDate, tz);
	let candidate = parsed;

	let y = partsInTimeZone(candidate, tz).year;
	if (y < nowParts.year) {
		candidate = new Date(candidate);
		candidate.setFullYear(nowParts.year);
	}

	const dateIso = formatDateIsoInTz(candidate, tz);
	const timeHHmm = formatTimeHHmmInTz(candidate, tz);
	const { scheduled_at, ends_at } = buildAppointmentRange(dateIso, timeHHmm);

	return {
		dateIso,
		timeHHmm,
		startIso: scheduled_at,
		endsAt: ends_at
	};
}
