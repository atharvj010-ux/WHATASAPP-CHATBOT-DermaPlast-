import { supabase } from "./supabaseClient.js";
import { parseTaskIntentFromText } from "./parseTaskIntent.js";
import { sendWhatsAppMessage } from "../twilio.js";
import { parseClinicDateTime } from "../crm/datetime.js";
import {
	insertTaskVerified,
	resolveCrmOwnerId,
	logCrmDebugSummary,
	findPatientForCrm
} from "../crm/db.js";
import {
	CRM_ERRORS,
	findPatientOrLeadByName,
	formatTaskSuccessMessage,
	logCrm,
	resolvePatientRecord
} from "../crm/crmIntegration.js";

const PRIORITY_MAP = new Map([
	["high", "P1"],
	["medium", "P2"],
	["low", "P3"]
]);

const DEFAULT_TASK_STATUS = "todo";
// Must match DB CHECK constraint on public.tasks.source.
// Current allowed values (see migration 20260502120000_tasks.sql):
//   - 'manual'
//   - 'ai_rule'
const DEFAULT_TASK_SOURCE = "manual";
const ALLOWED_TASK_SOURCES = new Set(["manual", "ai_rule"]);
const DEFAULT_OWNER_ID = process.env.SUPABASE_DEFAULT_OWNER_ID ?? null;

function normalizePriority(priorityText) {
	if (!priorityText) return "P3";
	const normalized = priorityText.toLowerCase();
	return PRIORITY_MAP.get(normalized) ?? "P3";
}

function parseNaturalDate(text) {
	if (!text) return null;
	const parsed = parseClinicDateTime(text);
	return parsed.startIso || null;
}

function looksLikeTaskRequest(text) {
	const t = String(text || "").toLowerCase();
	const hasTaskWord = /\b(task)\b/.test(t);
	const hasFollowUp = /\b(follow[\s-]?up)\b/.test(t);
	const hasReminder = /\b(reminder)\b/.test(t);
	const hasDatetime =
		/\b(tomorrow|today|next)\b/.test(t) ||
		/\b(after\s+\d+\s+days?)\b/.test(t) ||
		/\b(on|at)\b/.test(t) ||
		/\bat\s+\d{1,2}(\:\d{2})?\s*(am|pm)?\b/.test(t) ||
		/\b\d{1,2}(\:\d{2})?\s*(am|pm)\b/.test(t) ||
		/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/.test(t);

	return (
		(/\b(create|add|schedule)\b/.test(t) && (hasTaskWord || hasFollowUp)) ||
		/\b(follow[\s-]?up)\s+task\b/.test(t) ||
		/\bcreate\b.*\bfollow[\s-]?up\b/.test(t) ||
		hasReminder ||
		(hasFollowUp && hasDatetime)
	);
}

function extractPatientNameFallback(text) {
	const raw = String(text || "");
	// Prefer patterns: "for <Name> (patient)? <date/time>"
	const afterFor = raw.match(/\bfor\s+(.+?)\s+(patient\b)?(?=\bon\b|\bat\b|\btomorrow\b|\bnext\b|\bafter\s+\d+\s+days\b|\b\d{1,2}[:.]\d{2}\b|$)/i)?.[1];
	if (afterFor)
		return afterFor
			.trim()
			.replace(/\s+/g, " ")
			.replace(/\bpatient\b/i, "")
			.trim();
	// Fallback: "Create ... for <Name>"
	const afterFor2 = raw.match(/\bfor\s+(.+?)(?=($|\b(today|tomorrow|next|after)\b))/i)?.[1];
	if (!afterFor2) return null;
	return afterFor2
		.trim()
		.replace(/\s+/g, " ")
		.replace(/\bpatient\b/i, "")
		.trim();
}

function extractPriorityFallback(text) {
	const t = String(text || "").toLowerCase();
	if (/\b(high|urgent|asap)\b/.test(t)) return "high";
	if (/\b(medium|normal)\b/.test(t)) return "medium";
	if (/\b(low)\b/.test(t)) return "low";
	return null;
}

async function findPatientByName(name) {
	const scoped = await findPatientForCrm(name);
	if (scoped) return scoped;
	const lookup = await findPatientOrLeadByName(name);
	return resolvePatientRecord(lookup);
}

async function isDuplicateTask({ patientId, title, dueDate }) {
	const query = supabase
		.from("tasks")
		.select("id")
		.eq("linked_entity_type", "patient")
		.eq("linked_entity_id", patientId)
		.ilike("title", title)
		.limit(1);
	if (dueDate) {
		query.eq("due_date", dueDate);
	}
	const { data, error } = await query;
	if (error) {
		console.warn("[taskHandler] dedupe check failed", error.message);
		return false;
	}
	return Boolean(data?.length);
}

async function insertTask({ patientId, ownerId, title, dueDate, priority, originalText, source, project }) {
	const isFollowUp = /\bfollow[\s-]?up\b/i.test(title);
	const payload = {
		owner_id: ownerId,
		title,
		description: originalText,
		priority,
		status: DEFAULT_TASK_STATUS,
		due_date: dueDate,
		assigned_to: ownerId,
		assignee_display: "WhatsApp Bot",
		linked_entity_type: "patient",
		linked_entity_id: patientId,
		project: project ?? (isFollowUp ? "follow_ups" : null),
		tags: isFollowUp ? ["whatsapp", "follow-up"] : ["whatsapp"],
		source: source ?? DEFAULT_TASK_SOURCE,
		meta: { channel: "whatsapp", category: isFollowUp ? "follow-up" : "task" },
		created_by: ownerId
	};

	if (!ALLOWED_TASK_SOURCES.has(payload.source)) {
		throw new Error(`Invalid tasks.source value: ${payload.source}. Allowed: ${Array.from(ALLOWED_TASK_SOURCES).join(", ")}`);
	}

	const result = await insertTaskVerified(payload);
	if (!result.ok) {
		throw result.error || new Error("Task insert failed");
	}
	return result.record;
}

export async function handleTaskCreationFromWhatsApp({ from, messageSid, body }) {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "task-handler",
			event: "incoming_task_request",
			messageSid,
			from,
			bodyPreview: String(body || "").slice(0, 160),
			bodyLen: String(body || "").length
		})
	);

	const parsed = await parseTaskIntentFromText({ text: body });
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "task-handler",
			event: "parsed_intent",
			intent: parsed?.intent,
			taskTitle: parsed?.taskTitle,
			patientName: parsed?.patientName,
			dueDate: parsed?.dueDate,
			priority: parsed?.priority
		})
	);

	const shouldHandle = looksLikeTaskRequest(body);
	const intent = parsed.intent === "create_task" || shouldHandle ? "create_task" : "other";
	if (intent !== "create_task") return { handled: false };

	const patientName = parsed.patientName || extractPatientNameFallback(body);
	const dueDate = parseNaturalDate(parsed.dueDate) || parseNaturalDate(body);
	const priority = parsed.priority || extractPriorityFallback(body);
	const taskTitle =
		parsed.taskTitle ||
		(/\breminder\b/i.test(body) ? "Reminder" : null) ||
		(/\bfollow[\s-]?up\b/i.test(body) ? "Follow-up" : null) ||
		"Follow-up task";

	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "task-handler",
			event: "extracted_entities",
			patientName,
			taskTitle,
			dueDate,
			priority
		})
	);

	if (!patientName) {
		const twilioRes = await sendWhatsAppMessage({
			to: from,
			body: CRM_ERRORS.PATIENT_NOT_FOUND
		});
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "task-handler",
				event: "twilio_reply_sent",
				messageSid,
				twilio: { sid: twilioRes?.sid, status: twilioRes?.status }
			})
		);
		return { handled: true };
	}

	if (!dueDate) {
		const twilioRes = await sendWhatsAppMessage({
			to: from,
			body: CRM_ERRORS.MISSING_TASK_DATETIME
		});
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "task-handler",
				event: "missing_due_date",
				messageSid
			})
		);
		return { handled: true };
	}

	const patient = await findPatientByName(patientName);
	if (!patient) {
		logCrm("task_patient_not_found", { patientName });

		const twilioRes = await sendWhatsAppMessage({
			to: from,
			body: CRM_ERRORS.PATIENT_NOT_FOUND
		});
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "task-handler",
				event: "twilio_reply_sent",
				messageSid,
				twilio: { sid: twilioRes?.sid, status: twilioRes?.status }
			})
		);
		return { handled: true };
	}

	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "task-handler",
			event: "patient_lookup_result",
			patient: { id: patient.id, name: patient.name, owner_id: patient.owner_id ?? null }
		})
	);

	const ownerId = resolveCrmOwnerId(patient);
	if (!ownerId) {
		const twilioRes = await sendWhatsAppMessage({
			to: from,
			body: "❌ Cannot create task: patient does not have an owner assigned in CRM."
		});
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "task-handler",
				event: "twilio_reply_sent",
				messageSid,
				twilio: { sid: twilioRes?.sid, status: twilioRes?.status }
			})
		);
		return { handled: true };
	}

	const configuredSource = String(process.env.WHATSAPP_TASK_SOURCE || "").trim();
	const taskSource = ALLOWED_TASK_SOURCES.has(configuredSource) ? configuredSource : DEFAULT_TASK_SOURCE;
	if (configuredSource && !ALLOWED_TASK_SOURCES.has(configuredSource)) {
		console.warn(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "task-handler",
				event: "invalid_task_source_env",
				configuredSource
			})
		);
	}

	const normalizedPriority = normalizePriority(priority);
	const title = taskTitle.trim();
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "task-handler",
			event: "dedupe_check",
			patientId: patient.id,
			title,
			dueDate,
			source: taskSource
		})
	);
	const duplicate = await isDuplicateTask({
		patientId: patient.id,
		title,
		dueDate
	});
	if (duplicate) {
		const twilioRes = await sendWhatsAppMessage({
			to: from,
			body: "A similar task already exists for this patient. No action was taken."
		});
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "task-handler",
				event: "twilio_reply_sent",
				messageSid,
				twilio: { sid: twilioRes?.sid, status: twilioRes?.status }
			})
		);
		return { handled: true };
	}

	try {
		const inserted = await insertTask({
			patientId: patient.id,
			ownerId,
			title,
			dueDate,
			priority: normalizedPriority,
			originalText: body,
			source: taskSource,
			project: /\bfollow[\s-]?up\b/i.test(title) ? "follow_ups" : null
		});

		const successBody = formatTaskSuccessMessage(
			patient.name || "the patient",
			inserted.due_date || dueDate,
			title
		);
		logCrmDebugSummary({
			patientFound: true,
			patientId: patient.id,
			ownerId,
			taskCreated: true,
			taskId: inserted.id,
			dueDate: inserted.due_date
		});

		const twilioRes = await sendWhatsAppMessage({
			to: from,
			body: successBody
		});
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "task-handler",
				event: "twilio_reply_sent",
				messageSid,
				twilio: { sid: twilioRes?.sid, status: twilioRes?.status }
			})
		);
		return { handled: true };
	} catch (error) {
		const safeReason = error?.message ? String(error.message).slice(0, 220) : "Unknown database error";
		console.error("[taskHandler] task insert caught error:", error);

		logCrm("task_insert_failed", { error: safeReason });
		logCrmDebugSummary({
			patientFound: Boolean(patient),
			patientId: patient?.id,
			taskCreated: false,
			databaseError: safeReason
		});
		const twilioRes = await sendWhatsAppMessage({
			to: from,
			body: CRM_ERRORS.TASK_CREATE_FAILED
		});
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "task-handler",
				event: "twilio_reply_sent",
				messageSid,
				twilio: { sid: twilioRes?.sid, status: twilioRes?.status }
			})
		);
		return { handled: true };
	}
}
