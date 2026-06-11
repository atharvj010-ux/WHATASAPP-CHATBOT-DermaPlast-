import { getClinicTimezone } from "./clinicTimezone.js";

/**
 * Clinic availability for handoff messaging (approximate; override with env).
 * Default aligns with app/chatbot/kb/clinic_faq.json: Mon–Sat 10:00–20:00, Sunday closed for live handoff.
 */
export function isWithinBusinessHours(now = new Date()) {
	const tz = getClinicTimezone();
	const raw = String(process.env.CLINIC_BUSINESS_HOURS_JSON || "").trim();

	if (raw) {
		try {
			const cfg = JSON.parse(raw);
			const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(now);
			const hour = Number(
				new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now)
			);
			const minute = Number(
				new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone: tz }).format(now)
			);
			const h = hour + minute / 60;
			const dayKey = weekday.slice(0, 3);
			const day = cfg[dayKey];
			if (!day || !day.open || !day.close) return false;
			const [oh, om] = String(day.open).split(":").map(Number);
			const [ch, cm] = String(day.close).split(":").map(Number);
			const openH = oh + (om || 0) / 60;
			const closeH = ch + (cm || 0) / 60;
			return h >= openH && h < closeH;
		} catch {
			// fall through to defaults
		}
	}

	const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(now);
	const hour = Number(
		new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now)
	);
	const minute = Number(
		new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone: tz }).format(now)
	);
	const h = hour + minute / 60;

	if (weekday.startsWith("Sun")) return false;
	if (weekday.startsWith("Mon") || weekday.startsWith("Tue") || weekday.startsWith("Wed") || weekday.startsWith("Thu") || weekday.startsWith("Fri") || weekday.startsWith("Sat")) {
		return h >= 10 && h < 20;
	}
	return false;
}
