/** Supported patient languages */
export const LANG = {
	EN: "en",
	HI: "hi",
	MR: "mr"
};

/** Strong Marathi signals (Devanagari + Roman). */
const MR_STRONG_DEVA =
	/म्हणजे|म्हणजे काय|काय आहे|काय आहेत|केस गळत|गळत आहेत|नमस्कार|आहेत|आहे|करायच|माहितीसाठी|क्लिनिकला भेट/i;
const MR_STRONG_ROMAN =
	/\b(mhanje|mhata|mhanaje|kay ahe|kay aahe|kes galt|ghalat aahet|ghalat ahet|karaycha|sanga)\b/i;

/** Strong Hindi signals. */
const HI_STRONG_DEVA =
	/क्या है|क्या हैं|बाल झड़|झड़ रहे|नमस्ते|चाहते हैं|चाहिए|क्लिनिक में|क्लिनिक पर आएं/i;
const HI_STRONG_ROMAN =
	/\b(kya hai|kya h|matlab|bal jhad|jhad rahe|chahiye|chahate)\b/i;

/** Weak cues (need combination). */
const MR_WEAK_DEVA = /काय|आहे|माहिती|भेट/i;
const HI_WEAK_DEVA = /क्या|है|हैं|जानकारी|विजिट/i;
const MR_WEAK_ROMAN = /\b(kay|ahe|aahe|mahiti)\b/i;
const HI_WEAK_ROMAN = /\b(kya|hai|hain|kripya)\b/i;

const EN_STRONG = /^(what is|what's|what are|hello|hi|hey|good morning|good afternoon)\b/i;

export function hasDevanagariScript(text) {
	return /[\u0900-\u097F]/.test(String(text || ""));
}

function scoreLanguage(text, devaRe, romanRe) {
	const raw = String(text || "");
	return (raw.match(devaRe) || []).length + (raw.match(romanRe) || []).length;
}

export function isStrongLanguageSignal(text, lang) {
	const raw = String(text || "").trim();
	if (!raw) return false;

	if (lang === LANG.MR) {
		return MR_STRONG_DEVA.test(raw) || MR_STRONG_ROMAN.test(raw);
	}
	if (lang === LANG.HI) {
		return HI_STRONG_DEVA.test(raw) || HI_STRONG_ROMAN.test(raw);
	}
	if (lang === LANG.EN) {
		return EN_STRONG.test(raw) || (!hasDevanagariScript(raw) && !MR_STRONG_ROMAN.test(raw) && !HI_STRONG_ROMAN.test(raw) && /\b(what|how|when|where|please|appointment|transplant|therapy)\b/i.test(raw));
	}
	return false;
}

/** User explicitly asks to change reply language. */
export function isExplicitLanguageSwitchRequest(text) {
	const t = String(text || "").toLowerCase();
	return (
		/\b(reply|speak|answer|respond|tell me|batao|bataye|sanga)\b.*\b(in english|in hindi|in marathi|english mein|hindi mein|marathi mein)\b/.test(
			t
		) ||
		/\b(in english|in hindi|in marathi|english mein|hindi mein|marathi mein)\b/.test(t) ||
		/अंग्रेजी में|हिंदी में|मराठीत/.test(String(text || ""))
	);
}

/**
 * Detect language from a single message (en | hi | mr).
 * Marathi/Hindi disambiguation uses strong phrase markers first.
 */
export function detectLanguageFromMessage(text) {
	const raw = String(text || "").trim();
	if (!raw) return LANG.EN;

	const t = raw.toLowerCase();

	if (/^(नमस्कार|हॅलो)\b/.test(raw) || /^namaskar\b/i.test(t)) return LANG.MR;
	if (/^(नमस्ते|हैलो|हाय)\b/.test(raw) || /^namaste\b/i.test(t)) return LANG.HI;
	if (/^(hi|hello|hey|hii|good\s+(morning|afternoon|evening))\b/i.test(t)) return LANG.EN;

	if (MR_STRONG_DEVA.test(raw) || MR_STRONG_ROMAN.test(t)) {
		if (!(HI_STRONG_DEVA.test(raw) || HI_STRONG_ROMAN.test(t)) || MR_STRONG_DEVA.test(raw)) {
			if (MR_STRONG_DEVA.test(raw) || scoreLanguage(raw, MR_STRONG_DEVA, MR_STRONG_ROMAN) >= scoreLanguage(raw, HI_STRONG_DEVA, HI_STRONG_ROMAN)) {
				return LANG.MR;
			}
		}
	}

	if (HI_STRONG_DEVA.test(raw) || HI_STRONG_ROMAN.test(t)) return LANG.HI;

	if (EN_STRONG.test(t)) return LANG.EN;

	if (hasDevanagariScript(raw)) {
		const mrScore = scoreLanguage(raw, MR_WEAK_DEVA, MR_WEAK_ROMAN) + scoreLanguage(raw, MR_STRONG_DEVA, MR_STRONG_ROMAN) * 2;
		const hiScore = scoreLanguage(raw, HI_WEAK_DEVA, HI_WEAK_ROMAN) + scoreLanguage(raw, HI_STRONG_DEVA, HI_STRONG_ROMAN) * 2;
		if (mrScore > hiScore) return LANG.MR;
		if (hiScore > mrScore) return LANG.HI;
		return LANG.MR;
	}

	const mrScore = scoreLanguage(t, MR_WEAK_ROMAN, MR_STRONG_ROMAN);
	const hiScore = scoreLanguage(t, HI_WEAK_ROMAN, HI_STRONG_ROMAN);

	if (mrScore > hiScore && mrScore > 0) return LANG.MR;
	if (hiScore > mrScore && hiScore > 0) return LANG.HI;

	return LANG.EN;
}

/**
 * Reply language for this turn. Session updates on first message, explicit switch, or strong detection.
 * Weak/ambiguous messages keep the session language (no automatic drift).
 */
export function resolveSessionLanguage(session, userText) {
	const detected = detectLanguageFromMessage(userText);

	if (isExplicitLanguageSwitchRequest(userText)) {
		session.preferredLanguage = detected;
		return detected;
	}

	if (!session?.preferredLanguage) {
		session.preferredLanguage = detected;
		return detected;
	}

	if (isStrongLanguageSignal(userText, detected)) {
		session.preferredLanguage = detected;
		return detected;
	}

	return session.preferredLanguage;
}

export function languageLabel(lang) {
	if (lang === LANG.MR) return "Marathi";
	if (lang === LANG.HI) return "Hindi";
	return "English";
}

/** Language for short greetings. */
export function detectGreetingLanguage(text) {
	return detectLanguageFromMessage(text);
}
