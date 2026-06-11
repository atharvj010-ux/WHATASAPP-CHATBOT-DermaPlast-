import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "../tasks/supabaseClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_OWNER_ID = process.env.SUPABASE_DEFAULT_OWNER_ID ?? null;
const MAX_CASES = Number(process.env.RESULTS_MAX_CASES || 3);

const CATEGORY_TREATMENT_MATCH = {
	hair_transplant: /\b(hair\s+transplant|fue|fut|transplant|graft)\b/i,
	prp: /\b(prp|platelet)\b/i,
	hair_fall: /\b(hair\s+fall|hair\s+loss|mesotherapy|minoxidil|dermaroller)\b/i
};

const CATEGORY_INTRO = {
	general: "✨ Here are some of our best transformation results from Dermaplast Aesthetic Clinic.",
	hair_transplant: "✨ Here are some of our Hair Transplant before & after results.",
	prp: "✨ Here are some of our PRP treatment results.",
	hair_fall: "✨ Here are some of our Hair Fall treatment results."
};

const IMAGE_CAPTION = {
	general: "✨ Real transformation results from Dermaplast Aesthetic Clinic",
	hair_transplant: "✨ Real Hair Transplant Results from Dermaplast Aesthetic Clinic",
	prp: "✨ PRP Treatment Results from Dermaplast Aesthetic Clinic",
	hair_fall: "✨ Hair Fall Treatment Results from Dermaplast Aesthetic Clinic"
};

function isHttpsUrl(url) {
	return typeof url === "string" && /^https:\/\/.+/i.test(url.trim());
}

function caseMatchesCategory(row, category) {
	if (category === "general") return true;
	const name = String(row.treatment_name || "");
	const re = CATEGORY_TREATMENT_MATCH[category];
	return re ? re.test(name) : true;
}

function loadFallbackManifest() {
	const manifestPath = path.join(__dirname, "fallback-manifest.json");
	try {
		if (!fs.existsSync(manifestPath)) return null;
		const raw = fs.readFileSync(manifestPath, "utf8");
		const data = JSON.parse(raw);
		return data?.categories && typeof data.categories === "object" ? data.categories : null;
	} catch (err) {
		console.warn("[resultsCatalog] fallback manifest read failed", err?.message || err);
		return null;
	}
}

/**
 * @returns {Promise<{ category: string, intro: string, items: { label: string, beforeUrl: string, afterUrl: string }[] }>}
 */
export async function fetchResultImageSets(category = "general") {
	const ownerId = DEFAULT_OWNER_ID;
	let q = supabase
		.from("cases")
		.select("id,treatment_name,before_image_url,after_image_url,status,created_at")
		.not("before_image_url", "is", null)
		.not("after_image_url", "is", null)
		.order("created_at", { ascending: false })
		.limit(80);

	if (ownerId) q = q.eq("owner_id", ownerId);

	const { data, error } = await q;
	if (error) {
		console.error("[resultsCatalog] cases query failed", error.message);
		throw error;
	}

	const verified = (data ?? []).filter(
		(r) =>
			isHttpsUrl(r.before_image_url) &&
			isHttpsUrl(r.after_image_url) &&
			caseMatchesCategory(r, category) &&
			(r.status === "verified" || r.status === "pending")
	);

	const verifiedFirst = [
		...verified.filter((r) => r.status === "verified"),
		...verified.filter((r) => r.status !== "verified")
	];

	const picked = [];
	const seen = new Set();
	for (const row of verifiedFirst) {
		if (picked.length >= MAX_CASES) break;
		const key = `${row.before_image_url}|${row.after_image_url}`;
		if (seen.has(key)) continue;
		seen.add(key);
		picked.push({
			label: String(row.treatment_name || "Treatment").trim() || "Treatment",
			beforeUrl: String(row.before_image_url).trim(),
			afterUrl: String(row.after_image_url).trim()
		});
	}

	if (picked.length) {
		return {
			category,
			intro: CATEGORY_INTRO[category] || CATEGORY_INTRO.general,
			imageCaption: IMAGE_CAPTION[category] || IMAGE_CAPTION.general,
			items: picked
		};
	}

	// Optional local/static fallback for demos.
	const fallback = loadFallbackManifest();
	const fbCat = fallback?.[category] || fallback?.general;
	if (fbCat?.pairs?.length) {
		const items = fbCat.pairs
			.filter((p) => isHttpsUrl(p.before) && isHttpsUrl(p.after))
			.slice(0, MAX_CASES)
			.map((p) => ({
				label: String(p.label || "Treatment"),
				beforeUrl: String(p.before).trim(),
				afterUrl: String(p.after).trim()
			}));
		if (items.length) {
			return {
				category,
				intro: fbCat.intro || CATEGORY_INTRO[category] || CATEGORY_INTRO.general,
				imageCaption: fbCat.imageCaption || IMAGE_CAPTION[category] || IMAGE_CAPTION.general,
				items
			};
		}
	}

	return {
		category,
		intro: CATEGORY_INTRO[category] || CATEGORY_INTRO.general,
		imageCaption: IMAGE_CAPTION[category] || IMAGE_CAPTION.general,
		items: []
	};
}

export { MAX_CASES, CATEGORY_INTRO, IMAGE_CAPTION };
