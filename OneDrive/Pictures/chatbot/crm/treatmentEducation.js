import { normalizeWhatsAppFormatting } from "../tools.js";
import { isGenericTreatmentInquiry, isPricingMessage } from "./receptionistReplies.js";
import { LANG } from "./language.js";
import { treatmentEducationTemplate } from "./i18nMessages.js";
import { generateGeminiContent } from "../services/geminiService.js";

function isCrmBookingOrTaskMessage(text) {
	const raw = String(text || "");
	return (
		/\b(book|schedule|create)\b.*\b(appointment|consultation)\b/i.test(raw) ||
		/\bappointment\b.*\bfor\b/i.test(raw) ||
		(/\b(create|add|schedule)\b/i.test(raw) && (/\btask\b/i.test(raw) || /\bfollow[\s-]?up\b/i.test(raw)))
	);
}

const EDUCATION_CUE =
	/\b(what is|what's|what are|tell me about|explain|information about|details about|how does|how do|describe)\b/i;
const EDUCATION_CUE_HI =
	/\b(kya hai|kya hota|kya h|matlab|ke bare me|ke baare me|ka matlab|samjha|samjhaiye|batao|bataye)\b|क्या है|क्या हैं|मतलब/i;
const EDUCATION_CUE_MR =
	/\b(mhanje|mhata|kay|kasa|kashi|kase|kay ahe|mahiti|sanga|samjha|samjav)\b|म्हणजे|म्हणजे काय|काय आहे/i;

const TREATMENT_TOPIC =
	/\b(prp|gfc|hair transplant|hair treatment|skin treatment|dental|therapy|therapies|facial|botox|laser|microneedling|hydrafacial|transplant|platelet|fue|hair fall|hair loss|baldness|acne|chemical peel|beard)\b/i;

/** Specific patient-support: "What is hair transplant?", "Hair transplant mhanje kay?" */
export function isTreatmentEducationQuery(text) {
	const raw = String(text || "").trim();
	const t = raw.toLowerCase();
	if (!t || isCrmBookingOrTaskMessage(raw) || isPricingMessage(text)) return false;
	if (isGenericTreatmentInquiry(text)) return false;

	const hasCue = EDUCATION_CUE.test(t) || EDUCATION_CUE_HI.test(t) || EDUCATION_CUE_MR.test(t);
	const hasTopic = TREATMENT_TOPIC.test(t);

	if (hasCue && (hasTopic || raw.length > 12)) return true;
	if ((EDUCATION_CUE_HI.test(t) || EDUCATION_CUE_MR.test(t)) && hasTopic) return true;

	return false;
}

export function detectTreatmentEducationKey(text) {
	const t = String(text || "").toLowerCase();
	if (/\bprp\b/.test(t) || /platelet[\s-]?rich/.test(t)) return "prp";
	if (/\bhair\s+transplant\b/.test(t) || (/\btransplant\b/.test(t) && /\bhair|beard\b/.test(t))) {
		return /\bbeard\b/.test(t) ? "beard_transplant" : "hair_transplant";
	}
	if (/\bbeard\s+transplant\b/.test(t)) return "beard_transplant";
	if (/\bgfc\b/.test(t) || /growth factor concentrate/.test(t)) return "gfc";
	if (/\b(hair\s+fall|hair\s+loss|baldness|ganjapan)\b|केस गळत|बाल झड़/i.test(t)) return "hair_fall";
	if (/\bacne|pimple|muru?m\b/.test(t)) return "acne";
	if (/\b(skin\s+treatment|facial|laser|pigmentation|melasma)\b/.test(t)) return "skin";
	if (/\b(dental|teeth|tooth)\b/.test(t)) return "dental";
	if (/\b(cosmetic|aesthetic|botox|filler)\b/.test(t)) return "cosmetic";
	return null;
}

/**
 * @param {{ userText: string, lang: string, model?: string }}
 */
export async function generateTreatmentEducationReply({ userText, lang = LANG.EN, model }) {
	const key = detectTreatmentEducationKey(userText) || "generic";
	const l = lang === LANG.MR || lang === LANG.HI ? lang : LANG.EN;

	const template = treatmentEducationTemplate(l, key);
	if (template) {
		return normalizeWhatsAppFormatting(template);
	}

	if (model) {
		const langName = l === LANG.MR ? "Marathi" : l === LANG.HI ? "Hindi" : "English";
		const system = [
			`You are Dermaplast Aesthetic Clinic's patient assistant. Reply ONLY in ${langName}.`,
			"Give a SHORT friendly explanation (maximum 4 short lines, no long bullet lists).",
			"No pricing. No medical textbook language.",
			`End with clinic contact: Dermaplast Aesthetic Clinic, Panvel, phone +91 9988046049.`,
			`End with the appointment CTA in ${langName} (book appointment question).`
		].join("\n");

		const completion = await generateGeminiContent({
			model,
			temperature: 0.3,
			maxOutputTokens: 320,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: userText }
			]
		});

		const text = String(completion?.text || "").trim();
		if (text) return normalizeWhatsAppFormatting(text);
	}

	return normalizeWhatsAppFormatting(treatmentEducationTemplate(l, "generic"));
}
