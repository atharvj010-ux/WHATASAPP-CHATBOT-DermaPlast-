import { validateTwilioWebhookDetailed, sendWhatsAppMessage } from "./twilio.js";
import { hasProcessed, markProcessed, getSession, setSession } from "./store.js";
import { runAgent } from "./agent.js";
import { handleTaskCreationFromWhatsApp } from "./tasks/taskHandler.js";
import { handleAppointmentBookingFromWhatsApp } from "./appointments/appointmentHandler.js";
import { handleResultsSharingFromWhatsApp } from "./results/resultsHandler.js";
import { classifyInboundIntent, logCrm } from "./crm/crmIntegration.js";
import { logChatEvent } from "./services/loggerService.js";
import {
	loadPersistedSession,
	persistSession,
	insertChatMessage
} from "./services/sessionPersist.js";
import { detectLanguageFromMessage } from "./crm/language.js";

export const EMPTY_TWIML =
	'<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** Serialize async work per WhatsApp user to avoid overlapping replies. */
const userChains = new Map();

function logWebhook(event, data) {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "whatsapp-webhook",
			event,
			...data
		})
	);
}

function enqueueForUser(userId, fn) {
	const prev = userChains.get(userId) || Promise.resolve();
	const next = prev
		.then(fn)
		.catch((err) => {
			console.error("[whatsapp-queue]", userId, err);
		})
		.finally(() => {
			if (userChains.get(userId) === next) userChains.delete(userId);
		});
	userChains.set(userId, next);
	return next;
}

async function sendWhatsAppWithRetries({ to, body }) {
	let last;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const msg = await sendWhatsAppMessage({ to, body });
			return { ok: true, sid: msg?.sid, status: msg?.status, attempt };
		} catch (e) {
			last = e;
			console.warn("[twilio-send] attempt", attempt, e?.message || e, e?.code ?? "");
			await new Promise((r) => setTimeout(r, 400 * attempt));
		}
	}
	return { ok: false, error: last?.message || String(last), code: last?.code ?? null };
}

async function deliverAiReply({ from, userText, messageSid }) {
	const t0 = Date.now();
	let aiStatus = "ok";
	let reply = "";
	let sessionId = null;
	const inboundIntent = classifyInboundIntent(userText);
	const language = detectLanguageFromMessage(userText);

	await logChatEvent({
		channel: "whatsapp",
		userPhone: from,
		userRole: "patient",
		direction: "inbound",
		message: userText,
		detectedIntent: inboundIntent,
		language,
		responseTimeMs: Date.now() - t0
	});

	try {
		logWebhook("ai_start", {
			messageSid,
			from,
			userTextPreview: String(userText || "").slice(0, 280),
			userTextLen: String(userText || "").length
		});

		let session = getSession(from);
		if (!session.history?.length) {
			const persisted = await loadPersistedSession(from);
			if (persisted?.session) {
				session = persisted.session;
				sessionId = persisted.sessionId;
				setSession(from, session);
			}
		}

		const result = await runAgent({ from, userText, session });
		setSession(from, result.newSession);
		reply = result.reply || "";

		sessionId = await persistSession(from, result.newSession, { userRole: "patient" });
		if (sessionId) {
			await insertChatMessage(sessionId, "user", userText, { intent: inboundIntent });
			await insertChatMessage(sessionId, "assistant", reply, { intent: inboundIntent });
		}

		await logChatEvent({
			sessionId,
			channel: "whatsapp",
			userPhone: from,
			userRole: "patient",
			direction: "outbound",
			message: reply,
			detectedIntent: inboundIntent,
			finalResponse: reply,
			language,
			openaiUsed: false,
			responseTimeMs: Date.now() - t0
		});

		logWebhook("ai_generated", {
			messageSid,
			from,
			chars: reply.length,
			replyPreview: reply.slice(0, 280),
			msAi: Date.now() - t0
		});
	} catch (e) {
		aiStatus = "error";
		console.error("[agent]", messageSid, e);
		reply = "Sorry, our assistant is temporarily unavailable. Please try again.";
		await logChatEvent({
			channel: "whatsapp",
			userPhone: from,
			userRole: "patient",
			direction: "system",
			message: reply,
			detectedIntent: inboundIntent,
			finalResponse: reply,
			language,
			error: String(e?.message || e),
			responseTimeMs: Date.now() - t0
		});
		logWebhook("ai_fallback", {
			messageSid,
			from,
			error: String(e?.message || e),
			msAi: Date.now() - t0
		});
	}

	const sendStarted = Date.now();
	const sendResult = await sendWhatsAppWithRetries({ to: from, body: reply });
	const totalMs = Date.now() - t0;
	const sendMs = Date.now() - sendStarted;

	logWebhook("outbound_complete", {
		messageSid,
		from,
		aiStatus,
		twilioOk: sendResult.ok,
		twilioSid: sendResult.sid,
		twilioStatus: sendResult.status,
		twilioError: sendResult.error,
		twilioErrorCode: sendResult.code,
		chars: reply.length,
		msTotal: totalMs,
		msTwilio: sendMs
	});
}

async function processInboundMessage({ messageSid, from, userText }) {
	const inboundIntent = classifyInboundIntent(userText);
	logWebhook("intent_detected", { messageSid, from, inboundIntent });
	logCrm("inbound_message", { messageSid, from, inboundIntent, preview: userText.slice(0, 160) });

	const apptResult = await handleAppointmentBookingFromWhatsApp({
		from,
		body: userText
	});
	if (apptResult.handled) return;

	const taskResult = await handleTaskCreationFromWhatsApp({
		from,
		messageSid,
		body: userText
	});
	if (taskResult.handled) return;

	const resultsResult = await handleResultsSharingFromWhatsApp({
		from,
		body: userText,
		messageSid
	});
	if (resultsResult.handled) return;

	await deliverAiReply({ from, userText, messageSid });
}

/**
 * Handle a Twilio WhatsApp inbound webhook.
 * @param {object} opts
 * @param {Record<string, string>} opts.body - Parsed form fields (MessageSid, From, Body, …)
 * @param {Record<string, string|undefined>} opts.headers - Lower-case keys optional; x-twilio-signature read from raw headers
 * @param {import('express').Request | { get(name: string): string | undefined, originalUrl?: string, url?: string }} [opts.req] - Express req for signature + URL candidates
 * @param {string} [opts.publicWebhookUrl] - PUBLIC_WEBHOOK_URL override
 * @param {string} [opts.requestUrl] - Full public URL Twilio posted to (Next.js req.url)
 * @returns {Promise<{ status: number, body: string, contentType: string, ackSent: boolean, queued: boolean }>}
 */
export async function handleInboundWhatsApp({
	body,
	headers = {},
	req = null,
	publicWebhookUrl,
	requestUrl
}) {
	const started = Date.now();
	const getHeader = (name) => {
		if (req?.get) return req.get(name);
		const lower = name.toLowerCase();
		return headers[lower] ?? headers[name];
	};

	const fakeReq = req || {
		get: getHeader,
		headers: headers,
		originalUrl: requestUrl ? new URL(requestUrl).pathname : "/whatsapp",
		url: requestUrl ? new URL(requestUrl).pathname : "/whatsapp",
		body: body || {}
	};

	logWebhook("request_received", {
		path: fakeReq.originalUrl || fakeReq.url,
		requestUrl: requestUrl || null,
		twilioSignaturePresent: Boolean(getHeader("x-twilio-signature"))
	});

	const publicUrl = String(
		publicWebhookUrl ?? process.env.PUBLIC_WEBHOOK_URL ?? ""
	).trim();

	if (!publicUrl && requestUrl) {
		logWebhook("config_info", {
			reason: "using_request_url_for_signature",
			requestUrl
		});
	}

	const skipValidation =
		String(process.env.TWILIO_SKIP_VALIDATION || "").toLowerCase() === "true";

	if (!skipValidation) {
		const validation = validateTwilioWebhookDetailed({
			req: fakeReq,
			publicUrl: publicUrl || requestUrl || ""
		});
		logWebhook("signature_check", {
			ok: validation.ok,
			reason: validation.reason,
			matchedUrl: validation.matchedUrl,
			candidatesTried: validation.candidates
		});
		if (!validation.ok) {
			logWebhook("reject", {
				reason: "invalid_signature",
				publicUrl: publicUrl || requestUrl,
				requestPath: fakeReq.originalUrl
			});
			return {
				status: 403,
				body: "Invalid Twilio signature",
				contentType: "text/plain",
				ackSent: false,
				queued: false
			};
		}
	}

	const messageSid = body?.MessageSid;
	const from = body?.From;
	const rawBody = (body?.Body || "").trim();

	logWebhook("incoming", {
		messageSid,
		from,
		to: body?.To,
		profileName: body?.ProfileName,
		bodyPreview: rawBody.slice(0, 280),
		bodyLen: rawBody.length
	});

	if (!messageSid || !from) {
		logWebhook("reject", { reason: "bad_request" });
		return {
			status: 400,
			body: EMPTY_TWIML,
			contentType: "text/xml",
			ackSent: false,
			queued: false
		};
	}

	if (hasProcessed(messageSid)) {
		logWebhook("dedupe", { messageSid, from, ms: Date.now() - started });
		return {
			status: 200,
			body: EMPTY_TWIML,
			contentType: "text/xml",
			ackSent: true,
			queued: false
		};
	}
	markProcessed(messageSid);

	const userText = rawBody || "Hello";

	logWebhook("ack_sent", {
		messageSid,
		from,
		msAck: Date.now() - started,
		twiml: "empty_response_ack"
	});

	const work = () =>
		enqueueForUser(from, () =>
			processInboundMessage({ messageSid, from, userText })
		);

	return {
		status: 200,
		body: EMPTY_TWIML,
		contentType: "text/xml",
		ackSent: true,
		queued: true,
		runAsyncWork: work
	};
}
