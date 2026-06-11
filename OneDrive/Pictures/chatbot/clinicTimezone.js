const DEFAULT_TZ = "Asia/Kolkata";

/** Common env typos → valid IANA timezone */
const TZ_ALIASES = new Map([
	["asia/navi mumbai", "Asia/Kolkata"],
	["asia/navi-mumbai", "Asia/Kolkata"],
	["asia/mumbai", "Asia/Kolkata"],
	["ist", "Asia/Kolkata"],
	["india", "Asia/Kolkata"]
]);

function isValidIanaTimezone(tz) {
	try {
		Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve clinic timezone from env with validation and safe fallback.
 */
export function getClinicTimezone() {
	const raw = String(
		process.env.CLINIC_TIMEZONE || process.env.RESTAURANT_TIMEZONE || ""
	).trim();

	if (!raw) return DEFAULT_TZ;

	const alias = TZ_ALIASES.get(raw.toLowerCase());
	if (alias) {
		if (alias !== raw) {
			console.warn(`[clinicTimezone] Normalized invalid CLINIC_TIMEZONE "${raw}" → "${alias}"`);
		}
		return alias;
	}

	if (isValidIanaTimezone(raw)) return raw;

	console.warn(
		`[clinicTimezone] Invalid CLINIC_TIMEZONE "${raw}" — using ${DEFAULT_TZ}. Use IANA names like Asia/Kolkata.`
	);
	return DEFAULT_TZ;
}
