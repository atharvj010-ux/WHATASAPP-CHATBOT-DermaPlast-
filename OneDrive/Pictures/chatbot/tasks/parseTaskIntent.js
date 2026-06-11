import { generateGeminiContent, DEFAULT_GEMINI_MODEL } from "../services/geminiService.js";

const SYSTEM_PROMPT = `
You are a structured parser. Extract intent and entities from a conversational task request.
Respond with JSON only, no surrounding text. The schema must include:
{
  "intent": "create_task" | "other",
  "taskTitle": string | null,
  "patientName": string | null,
  "dueDate": string | null,
  "priority": "high" | "medium" | "low" | null
}
Rules:
- Recognize requests like: "create task", "add task", "follow up task", "reminder" (when it includes a time/date), "schedule a follow-up task".
- patientName should be the patient's full name. Ignore the word "patient" if it appears after the name (e.g., "Kunal patient").
- dueDate should be an ISO 8601 datetime when the user mentions a clear date/time (e.g., "tomorrow at 5 PM", "next Monday 10:30", "23 May at 5 PM").
- If dueDate cannot be determined, return null.
- taskTitle can be a short description of the task (e.g., "Follow-up", "Follow up", "Call back follow-up", "Reminder"). If missing, set taskTitle to null.
Respond with { "intent": "other" } when it is not a task request.
`;

export async function parseTaskIntentFromText({ text }) {
	if (!text) {
		return { intent: "other", taskTitle: null, patientName: null, dueDate: null, priority: null };
	}

	function extractJsonObject(s) {
		if (!s) return null;
		const str = String(s);
		const noFences = str.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
		const first = noFences.indexOf("{");
		const last = noFences.lastIndexOf("}");
		if (first >= 0 && last > first) return noFences.slice(first, last + 1);
		return noFences;
	}

	try {
		const response = await generateGeminiContent({
			model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
			temperature: 0,
			maxOutputTokens: 400,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{
					role: "user",
					content: `Message: """${text}"""`
				}
			],
			responseMimeType: "application/json"
		});

		const raw = response.text ?? "";
		const trimmed = raw?.trim();
		if (!trimmed) return { intent: "other", taskTitle: null, patientName: null, dueDate: null, priority: null };

		const jsonStr = extractJsonObject(trimmed);
		if (!jsonStr) return { intent: "other", taskTitle: null, patientName: null, dueDate: null, priority: null };

		const parsed = JSON.parse(jsonStr);
		return {
			intent: parsed.intent === "create_task" ? "create_task" : "other",
			taskTitle: typeof parsed.taskTitle === "string" ? parsed.taskTitle.trim() : null,
			patientName: typeof parsed.patientName === "string" ? parsed.patientName.trim() : null,
			dueDate: typeof parsed.dueDate === "string" ? parsed.dueDate.trim() : null,
			priority: parsed.priority === "high" || parsed.priority === "medium" || parsed.priority === "low" ? parsed.priority : null
		};
	} catch (err) {
		console.error("[parseTaskIntent]", err);
		return { intent: "other", taskTitle: null, patientName: null, dueDate: null, priority: null };
	}
}
