import twilio from "twilio";

/**
 * Build candidate URLs Twilio may have used when signing the request.
 * Twilio signs the exact webhook URL configured in Console (scheme + host + path, no trailing slash mismatch).
 * Common mistakes: .env has only the ngrok origin, or a leading space, or missing /webhook.
 */
export function buildTwilioWebhookUrlCandidates(req, publicUrlFromEnv) {
	const raw = String(publicUrlFromEnv || "").trim();
	const candidates = [];

	const forwardedProto = (req.get("x-forwarded-proto") || "").split(",")[0].trim();
	const forwardedHost = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
	const path = (req.originalUrl || req.url || "").split("?")[0];

	if (raw) {
		candidates.push(raw);
		try {
			const u = new URL(raw);
			// Always try origin + actual request path so env path mismatch (e.g. /webhook vs /whatsapp) does not break validation.
			if (u.origin && path) {
				candidates.push(`${u.origin}${path}`);
			}
			// If user pasted only https://subdomain.ngrok-free.dev (path is /), append this request path.
			if (u.pathname === "/" || u.pathname === "") {
				candidates.push(`${u.origin}${path}`);
			}
			// Trailing slash variants
			if (!raw.endsWith("/")) candidates.push(`${raw}/`);
			else candidates.push(raw.replace(/\/+$/, ""));
		} catch {
			// ignore invalid URL
		}
	}

	// Reconstruct from proxy headers (ngrok sets these); Twilio posts to the public URL.
	if (forwardedHost && path) {
		const proto = forwardedProto || "https";
		candidates.push(`${proto}://${forwardedHost}${path}`);
	}

	// Dedupe while preserving order
	const seen = new Set();
	return candidates.filter((u) => {
		if (!u || seen.has(u)) return false;
		seen.add(u);
		return true;
	});
}

export function getTwilioClient() {
	const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
	if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
		throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
	}
	return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/**
 * Validate Twilio webhook signature to prevent spoofed requests.
 * `publicUrl` should be the full webhook URL from env; we also try derived URLs when only the origin was set.
 */
export function validateTwilioWebhook({ req, publicUrl }) {
	const out = validateTwilioWebhookDetailed({ req, publicUrl });
	return out.ok;
}

/**
 * Detailed Twilio signature validation output for logging/diagnostics.
 */
export function validateTwilioWebhookDetailed({ req, publicUrl }) {
	const signature = req.headers["x-twilio-signature"];
	if (!signature) {
		return { ok: false, reason: "missing_signature", matchedUrl: null, candidates: [] };
	}

	const authToken = process.env.TWILIO_AUTH_TOKEN;
	const candidates = buildTwilioWebhookUrlCandidates(req, publicUrl);

	for (const url of candidates) {
		if (twilio.validateRequest(authToken, signature, url, req.body || {})) {
			return { ok: true, reason: "matched", matchedUrl: url, candidates };
		}
	}
	console.warn("Twilio signature validation failed. Tried URLs:", candidates);
	return { ok: false, reason: "no_match", matchedUrl: null, candidates };
}

/**
 * Send a WhatsApp message via Twilio REST API.
 */
/**
 * Twilio WhatsApp-enabled sender. Accepts TWILIO_WHATSAPP_FROM or TWILIO_WHATSAPP_NUMBER.
 */
export function getWhatsAppFromNumber() {
	// Prefer TWILIO_WHATSAPP_NUMBER (production sender) over legacy TWILIO_WHATSAPP_FROM (often Sandbox).
	const raw = String(
		process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_WHATSAPP_FROM || ""
	).trim();
	if (!raw) return null;
	if (raw.startsWith("whatsapp:")) return raw;
	const n = raw.replace(/\s+/g, "");
	if (n.startsWith("+")) return `whatsapp:${n}`;
	return `whatsapp:+${n.replace(/^\+/, "")}`;
}

function logTwilioSendFailure(err, context) {
	const code = err?.code ?? err?.status ?? null;
	const more = err?.moreInfo ?? null;
	console.error(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "twilio-whatsapp-send",
			event: "failed",
			code,
			status: err?.status ?? null,
			message: err?.message ?? String(err),
			moreInfo: more,
			...context
		})
	);
	if (code === 63016 || code === "63016") {
		console.error(
			"[twilio] Outside the 24-hour WhatsApp session window — user must message the clinic number first, or use an approved template."
		);
	}
	if (code === 63007 || code === "63007") {
		console.error(
			"[twilio] WhatsApp channel not found for From address — verify TWILIO_WHATSAPP_NUMBER matches your active WhatsApp Sender in Twilio Console."
		);
	}
}

export async function sendWhatsAppMessage({ to, body }) {
	const client = getTwilioClient();
	const from = getWhatsAppFromNumber();
	if (!from) {
		throw new Error("Missing TWILIO_WHATSAPP_FROM or TWILIO_WHATSAPP_NUMBER");
	}

	try {
		const appBase = String(process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim();
		const statusCallback =
			appBase && /^https:\/\//i.test(appBase)
				? `${appBase.replace(/\/+$/, "")}/api/twilio/status-callback`
				: undefined;

		const msg = await client.messages.create({
			from,
			to,
			body,
			statusCallback
		});
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "twilio-whatsapp-send",
				event: "queued",
				sid: msg.sid,
				status: msg.status,
				from,
				to,
				bodyLen: String(body || "").length,
				hasStatusCallback: Boolean(statusCallback)
			})
		);
		return msg;
	} catch (err) {
		logTwilioSendFailure(err, { from, to, bodyLen: String(body || "").length });
		throw err;
	}
}

/**
 * Send WhatsApp message with one image (Twilio Media API).
 * `mediaUrl` must be a publicly reachable HTTPS URL.
 */
export async function sendWhatsAppMediaMessage({ to, body, mediaUrl }) {
	const client = getTwilioClient();
	const from = getWhatsAppFromNumber();
	if (!from) {
		throw new Error("Missing TWILIO_WHATSAPP_FROM or TWILIO_WHATSAPP_NUMBER");
	}
	const url = String(mediaUrl || "").trim();
	if (!url) {
		throw new Error("mediaUrl is required for sendWhatsAppMediaMessage");
	}

	try {
		const appBase = String(process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim();
		const statusCallback =
			appBase && /^https:\/\//i.test(appBase)
				? `${appBase.replace(/\/+$/, "")}/api/twilio/status-callback`
				: undefined;

		const msg = await client.messages.create({
			from,
			to,
			body: body || undefined,
			mediaUrl: [url],
			statusCallback
		});

		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "twilio-whatsapp-send",
				event: "media_queued",
				sid: msg.sid,
				status: msg.status,
				from,
				to,
				mediaUrl: url,
				hasBody: Boolean(body),
				hasStatusCallback: Boolean(statusCallback)
			})
		);
		return msg;
	} catch (err) {
		logTwilioSendFailure(err, { from, to, mediaUrl: url });
		throw err;
	}
}
