import { generateGeminiContent, DEFAULT_GEMINI_MODEL } from "../services/geminiService.js";

const SYSTEM_PROMPT = `
You extract appointment booking details from WhatsApp messages for a dermatology clinic CRM.
Return JSON only (no markdown), schema:
{
  "intent": "book_appointment" | "reschedule_appointment" | "cancel_appointment" | "other",
  "patientName": string | null,
  "treatmentOrService": string | null,
  "appointmentKind": "consultation" | "treatment" | "followup" | "urgent" | null,
  "clinician": string | null,
  "location": string | null,
  "dueDate": string | null,
  "dueTime": string | null,
  "notes": string | null
}

Rules:
- intent book_appointment: user wants to book/schedule an appointment (e.g. "book consultation", "schedule PRP", "appointment for X").
- intent reschedule_appointment: change/move existing appointment.
- intent cancel_appointment: cancel appointment.
- patientName: full patient name; strip trailing word "patient" if present.
- treatmentOrService: e.g. "PRP", "hair fall consultation", "HydraFacial".
- appointmentKind: map to consultation, treatment, followup, or urgent when clear.
- dueDate: ISO date YYYY-MM-DD if clear; else null.
- dueTime: 24h HH:mm if clear; else null for vague "evening" (caller will parse separately).
- Use clinic timezone context in user message only as hint; do not invent dates.
If not a booking-related message, return intent "other".
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

export async function parseAppointmentIntentFromText({ text }) {
	const empty = {
		intent: "other",
		patientName: null,
		treatmentOrService: null,
		appointmentKind: null,
		clinician: null,
		location: null,
		dueDate: null,
		dueTime: null,
		notes: null
	};
	if (!text?.trim()) return empty;

	try {
		const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
		const response = await generateGeminiContent({
			model,
			temperature: 0,
			maxOutputTokens: 400,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: `Message: """${text}"""` }
			],
			responseMimeType: "application/json"
		});

		const raw = String(response.text ?? "").trim();
		const jsonStr = extractJsonObject(raw);
		if (!jsonStr) return empty;

		const parsed = JSON.parse(jsonStr);
		const kind = ["consultation", "treatment", "followup", "urgent"].includes(parsed.appointmentKind)
			? parsed.appointmentKind
			: null;

		return {
			intent: ["book_appointment", "reschedule_appointment", "cancel_appointment"].includes(parsed.intent)
				? parsed.intent
				: "other",
			patientName: typeof parsed.patientName === "string" ? parsed.patientName.trim() : null,
			treatmentOrService:
				typeof parsed.treatmentOrService === "string" ? parsed.treatmentOrService.trim() : null,
			appointmentKind: kind,
			clinician: typeof parsed.clinician === "string" ? parsed.clinician.trim() : null,
			location: typeof parsed.location === "string" ? parsed.location.trim() : null,
			dueDate: typeof parsed.dueDate === "string" ? parsed.dueDate.trim() : null,
			dueTime: typeof parsed.dueTime === "string" ? parsed.dueTime.trim() : null,
			notes: typeof parsed.notes === "string" ? parsed.notes.trim() : null
		};
	} catch (err) {
		console.error("[parseAppointmentIntent]", err?.message || err);
		return empty;
	}
}
