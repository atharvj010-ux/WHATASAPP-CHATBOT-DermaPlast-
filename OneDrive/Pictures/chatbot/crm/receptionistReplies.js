/** Fixed receptionist templates — generic treatment/pricing redirects only. */

import { LANG, hasDevanagariScript } from "./language.js";
import { msg, buildFullClinicInfoReply } from "./i18nMessages.js";
import { getClinicFacts } from "./clinicInfo.js";

function clinicPhone() {
	return getClinicFacts().phone;
}

function normalizeLang(lang) {
	return lang === LANG.MR || lang === LANG.HI ? lang : LANG.EN;
}

/** Block FAQ for vague treatment/pricing only — not specific "What is PRP?" education. */
export function isKnowledgeTopicBlocked(text) {
	return isPricingMessage(text) || isGenericTreatmentInquiry(text);
}

export function buildGreetingReply(lang = LANG.EN) {
	return buildFullClinicInfoReply(normalizeLang(lang));
}

export function buildTreatmentInterestReply(lang = LANG.EN) {
	return msg(normalizeLang(lang), "treatmentGeneric");
}

export function buildPricingReply(lang = LANG.EN) {
	return msg(normalizeLang(lang), "pricing");
}

export function buildAppointmentGuidanceReply(lang = LANG.EN) {
	return msg(normalizeLang(lang), "appointmentBookHint");
}

export function buildFollowUpTaskGuidanceReply() {
	const phone = clinicPhone();
	return [
		"To create a follow-up task in the clinic system, send:",
		"",
		"Create follow-up task for <Patient Name> on <date> at <time>",
		"",
		"Example:",
		"Create follow-up task for Aditya Kulkarni on 23 May at 5 PM",
		"",
		`📞 Contact: ${phone}`
	].join("\n");
}

export function buildReceptionistGeneralReply(lang = LANG.EN) {
	return msg(normalizeLang(lang), "general");
}

export function isGreetingMessage(text) {
	const raw = String(text || "").trim();
	const t = raw.toLowerCase();
	if (!t || t.length > 120) return false;
	if (/^(hi|hello|hey|hii|hola|namaste|namaskar|good\s+(morning|afternoon|evening)|gm|good\s+day)\b/.test(t)) {
		return true;
	}
	if (/^(नमस्कार|नमस्ते|हॅलो|हैलो|हैलो!|हाय)\b/.test(raw)) return true;
	return false;
}

/** Greeting with full clinic details (address, timings, contact). */
export function buildLocalizedGreeting(lang) {
	return buildFullClinicInfoReply(normalizeLang(lang));
}

function isCrmBookingOrTaskMessage(text) {
	const raw = String(text || "");
	return (
		/\b(book|schedule|create)\b.*\b(appointment|consultation)\b/i.test(raw) ||
		/\bappointment\b.*\bfor\b/i.test(raw) ||
		(/\b(create|add|schedule)\b/i.test(raw) && (/\btask\b/i.test(raw) || /\bfollow[\s-]?up\b/i.test(raw)))
	);
}

export function isPricingMessage(text) {
	const raw = String(text || "").trim();
	const t = raw.toLowerCase();
	if (!t || isCrmBookingOrTaskMessage(raw)) return false;

	if (/^(pricing|price|cost|charges|charge|fees?|quotation|quotes?|rates?|packages?)\s*\??$/i.test(raw)) {
		return true;
	}

	if (
		/\b(price|pricing|cost|charges|charge|fee|fees|package|packages|quotation|quote|quotes|discount|how much|rupees|rs\.?|inr|kimmat|daam|kiti|kitna|kay paise)\b/.test(
			t
		)
	) {
		return true;
	}
	if (/\b(कीमत|खर्च|दर|कितना|किती)\b/.test(raw)) return true;

	if (/\b(consultation\s+(fee|fees|charge|charges|cost|price|pricing))\b/.test(t)) {
		return true;
	}

	if (
		/\b(hair\s+transplant|hair\s+treatment|prp|gfc|skin|dental|aesthetic|transplant)\b.*\b(cost|price|pricing|charge|charges|fee|fees)\b/.test(
			t
		)
	) {
		return true;
	}

	if (
		/\b(cost|price|pricing|charge|charges|fee|fees)\b.*\b(hair\s+transplant|hair\s+treatment|prp|gfc|transplant)\b/.test(
			t
		)
	) {
		return true;
	}

	return false;
}

/** Vague treatment interest only — Treatment?, Hair Treatment?, what treatments do you offer */
export function isGenericTreatmentInquiry(text) {
	const raw = String(text || "").trim();
	const t = raw.toLowerCase();
	if (!t || isCrmBookingOrTaskMessage(raw)) return false;
	if (isPricingMessage(text)) return false;

	if (/^treatments?\s*\??$/i.test(raw)) return true;
	if (/^hair\s+treatments?\s*\??$/i.test(raw)) return true;
	if (/^(skin|dental|aesthetic)\s+treatments?\s*\??$/i.test(raw)) return true;

	if (/\bwhat treatment|which treatment|treatments? do you|do you provide|types of treatment\b/.test(t)) {
		return true;
	}

	return false;
}

/** @deprecated Use isGenericTreatmentInquiry */
export function isTreatmentMessage(text) {
	return isGenericTreatmentInquiry(text);
}

/** Hard redirect for pricing + vague treatment only. */
export function resolveBlockedTopicReply(text, lang = LANG.EN) {
	const l = normalizeLang(lang);
	if (isPricingMessage(text)) return buildPricingReply(l);
	if (isGenericTreatmentInquiry(text)) return buildTreatmentInterestReply(l);
	return null;
}

export { LANG, hasDevanagariScript };
