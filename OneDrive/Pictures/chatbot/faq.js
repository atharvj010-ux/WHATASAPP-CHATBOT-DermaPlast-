import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isKnowledgeTopicBlocked } from "./crm/receptionistReplies.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cache;
let cacheMtime = 0;

function defaultFaqPaths() {
	const custom = String(process.env.CLINIC_FAQ_PATH || "").trim();
	const paths = [];
	if (custom) paths.push(custom);
	paths.push(path.join(__dirname, "..", "app", "chatbot", "kb", "clinic_faq.json"));
	return paths;
}

function tokenize(s) {
	return String(s || "")
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 1);
}

const FAQ_STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"you",
	"your",
	"are",
	"how",
	"what",
	"is",
	"do",
	"does",
	"can",
	"please",
	"tell",
	"about",
	"me",
	"to",
	"a",
	"an",
	"of",
	"in",
	"on",
	"at"
]);

function buildRegexesFromQuestion(q) {
	const words = tokenize(q).filter((w) => !FAQ_STOPWORDS.has(w));
	if (!words.length) return [/\b^$/];
	return words.map((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
}

/**
 * @returns {{ entries: Array<{ q: string, answer: string, _regexes: RegExp[] }> }}
 */
export function loadFaq() {
	const paths = defaultFaqPaths();
	let filePath;
	let raw;

	for (const p of paths) {
		try {
			if (!fs.existsSync(p)) continue;
			const st = fs.statSync(p);
			if (cache && p === filePath && st.mtimeMs === cacheMtime) return cache;
			raw = fs.readFileSync(p, "utf8");
			filePath = p;
			cacheMtime = st.mtimeMs;
			break;
		} catch {
			// try next
		}
	}

	if (!raw) {
		return { entries: [] };
	}

	let arr;
	try {
		arr = JSON.parse(raw);
	} catch {
		return { entries: [] };
	}

	const entries = (Array.isArray(arr) ? arr : []).map((row) => {
		const q = row.q || row.question || "";
		const answer = row.a || row.answer || "";
		return {
			q,
			answer,
			_regexes: buildRegexesFromQuestion(q)
		};
	});

	cache = { entries, _path: filePath };
	return cache;
}

/**
 * Lightweight FAQ match without LLM (overlap score + regex from question words).
 */
export function matchFaqSync(userText) {
	const t = String(userText || "").trim();
	if (!t) return null;
	if (isKnowledgeTopicBlocked(userText)) return null;
	const { entries } = loadFaq();
	const ut = tokenize(t).filter((w) => !FAQ_STOPWORDS.has(w));
	if (!ut.length) return null;

	let best = null;
	let bestScore = 0;

	for (const e of entries) {
		const eq = tokenize(e.q).filter((w) => !FAQ_STOPWORDS.has(w));
		const set = new Set(eq);
		let overlap = 0;
		for (const w of ut) {
			if (set.has(w)) overlap++;
		}
		const regexHit = e._regexes.some((r) => r.test(t));
		const score = overlap * 2 + (regexHit ? 3 : 0);
		if (score > bestScore) {
			bestScore = score;
			best = e;
		}
	}

	// Require stronger signal to avoid generic false matches (e.g. "what is ...")
	if (best && bestScore >= 5) return best.answer;
	return null;
}
