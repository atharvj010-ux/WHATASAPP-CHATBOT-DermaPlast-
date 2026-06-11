import { generateGeminiContent, DEFAULT_GEMINI_MODEL } from "../services/geminiService.js";

const SYSTEM_PROMPT = `
You classify WhatsApp messages for a dermatology/hair clinic results gallery.
Return JSON only:
{
  "intent": "show_results" | "other",
  "category": "general" | "hair_transplant" | "prp" | "hair_fall" | null
}

Rules:
- show_results: user wants before/after photos, transformation results, patient results images.
- category hair_transplant: hair transplant, FUE, FUT, transplant results/images.
- category prp: PRP, platelet-rich plasma results.
- category hair_fall: hair fall, hair loss treatment results.
- category general: vague "show results" without specific treatment.
- If intent is other, category must be null.
`.trim();

function extractJsonObject(s) {
	if (!s) return null;
	const str = String(s);
	const noFences = str.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
	const first = noFences.indexOf("{");
	const last = noFences.lastIndexOf("}");
	if (first >= 0 && last > first) return noFences.slice(first, last + 1);
	return noFences;
}

export function detectResultsCategoryFromKeywords(text) {
	const t = String(text || "").toLowerCase();
	if (/\b(prp|platelet)\b/.test(t)) return "prp";
	if (/\b(hair\s+transplant|fue|fut|transplant)\b/.test(t)) return "hair_transplant";
	if (/\b(hair\s+fall|hair\s+loss|hair\s+treatment)\b/.test(t)) return "hair_fall";
	return "general";
}

export function looksLikeResultsRequest(text) {
	const t = String(text || "").toLowerCase();
	const wantsMedia =
		/\b(results?|outcomes?)\b/.test(t) ||
		/\b(before\s*[-_]?\s*after|after\s*[-_]?\s*before|b\/a)\b/.test(t) ||
		/\b(transformation|transplant\s+results?|treatment\s+results?)\b/.test(t) ||
		/\b(patient\s+results?|success\s+stor(y|ies))\b/.test(t) ||
		/\b(results?\s+gallery|gallery\s+results?)\b/.test(t) ||
		(/\b(hair\s+transplant|prp|gfc|hair\s+fall|hair\s+loss)\b/.test(t) &&
			/\b(results?|photos?|images?|pictures?|before|after)\b/.test(t)) ||
		(/\b(show|share|send|see|view|want|need|can\s+i\s+see|any)\b/.test(t) &&
			/\b(results?|photos?|images?|pictures?|transformations?)\b/.test(t)) ||
		(/\b(before|after)\b/.test(t) && /\b(images?|photos?|pictures?)\b/.test(t));

	if (!wantsMedia) return false;

	// Do not intercept appointment/task booking phrases.
	if (/\b(book|schedule|fix|set)\b/.test(t) && /\b(appointment|consultation|slot|visit)\b/.test(t)) {
		return false;
	}
	if (/\b(create|add)\b/.test(t) && /\b(task|follow[\s-]?up)\b/.test(t)) {
		return false;
	}
	return true;
}

export async function parseResultsIntentFromText({ text }) {
	const fallback = { intent: "other", category: null };
	if (!text?.trim()) return fallback;

	if (!looksLikeResultsRequest(text)) return fallback;

	const keywordCategory = detectResultsCategoryFromKeywords(text);
	try {
		const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
		const response = await generateGeminiContent({
			model,
			temperature: 0,
			maxOutputTokens: 120,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: `Message: """${text}"""` }
			],
			responseMimeType: "application/json"
		});

		const raw = String(response.text ?? "").trim();
		const jsonStr = extractJsonObject(raw);
		if (!jsonStr) return { intent: "show_results", category: keywordCategory };

		const parsed = JSON.parse(jsonStr);
		const category = ["general", "hair_transplant", "prp", "hair_fall"].includes(parsed.category)
			? parsed.category
			: keywordCategory;

		if (parsed.intent !== "show_results") {
			// Never downgrade when keywords clearly ask for result images.
			if (looksLikeResultsRequest(text)) {
				return { intent: "show_results", category: keywordCategory };
			}
			return { intent: "other", category: null };
		}
		return { intent: "show_results", category };
	} catch (err) {
		console.warn("[parseResultsIntent]", err?.message || err);
		return { intent: "show_results", category: keywordCategory };
	}
}
