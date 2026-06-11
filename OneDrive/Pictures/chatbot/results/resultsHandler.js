import { sendWhatsAppMessage, sendWhatsAppMediaMessage } from "../twilio.js";
import { getSession, setSession } from "../store.js";
import {
	detectResultsCategoryFromKeywords,
	looksLikeResultsRequest,
	parseResultsIntentFromText
} from "./parseResultsIntent.js";
import { RESULTS_STATIC_CAPTION } from "./staticResults.js";
import {
	getResultsMediaBaseUrl,
	resolveAllResultMediaUrls,
	probeMediaUrl
} from "./resultsMedia.js";
import { resolveSupabaseResultMediaUrls } from "./resultsMediaSupabase.js";
import { STATIC_RESULT_IMAGES } from "./staticResults.js";

const COOLDOWN_MS = Number(process.env.RESULTS_RESEND_COOLDOWN_MS || 120000);
const SEND_DELAY_MS = Number(process.env.RESULTS_SEND_DELAY_MS || 450);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeSession(session, patch) {
	return { ...session, ...patch };
}

/**
 * @returns {Promise<{ handled: boolean }>}
 */
export async function handleResultsSharingFromWhatsApp({ from, body, messageSid }) {
	const text = String(body || "").trim();
	if (!text) return { handled: false };

	if (!looksLikeResultsRequest(text)) return { handled: false };

	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "results-handler",
			event: "incoming_results_request",
			messageSid,
			from,
			textPreview: text.slice(0, 200)
		})
	);

	const session = getSession(from);
	let parsed = await parseResultsIntentFromText({ text });
	if (parsed.intent !== "show_results") {
		parsed = { intent: "show_results", category: detectResultsCategoryFromKeywords(text) };
	}

	const category = parsed.category || detectResultsCategoryFromKeywords(text);
	const now = Date.now();

	if (
		session.resultsLastCategory === category &&
		session.resultsLastSentAt &&
		now - session.resultsLastSentAt < COOLDOWN_MS
	) {
		await sendWhatsAppMessage({
			to: from,
			body: "I recently shared those results with you. Reply with another treatment name (e.g. PRP or hair transplant) for a different set."
		});
		return { handled: true };
	}

	const envUrls = String(process.env.WHATSAPP_RESULT_MEDIA_URLS || "")
		.split(",")
		.map((u) => u.trim())
		.filter(Boolean);

	let mediaItems = [];

	if (envUrls.length >= STATIC_RESULT_IMAGES.length) {
		mediaItems = STATIC_RESULT_IMAGES.map((file, i) => ({ file, url: envUrls[i] }));
	} else {
		const mediaBaseUrl = getResultsMediaBaseUrl();
		if (mediaBaseUrl && /^https:\/\//i.test(mediaBaseUrl)) {
			mediaItems = await resolveAllResultMediaUrls(mediaBaseUrl);
		}
	}

	if (mediaItems.length < STATIC_RESULT_IMAGES.length) {
		console.log("[resultsHandler] HTTP media URLs unavailable — using Supabase public storage fallback");
		try {
			mediaItems = await resolveSupabaseResultMediaUrls();
		} catch (err) {
			console.error("[resultsHandler] Supabase media fallback failed", err?.message || err);
		}
	}

	// Final validation: Twilio must get image/* responses
	const validated = [];
	for (const item of mediaItems) {
		if (await probeMediaUrl(item.url)) {
			validated.push(item);
		} else {
			console.warn("[resultsHandler] dropping unreachable media URL", item.url);
		}
	}
	mediaItems = validated;

	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "results-handler",
			event: "results_media_resolved",
			resolvedCount: mediaItems.length,
			urls: mediaItems.map((m) => m.url)
		})
	);

	if (mediaItems.length === 0) {
		await sendWhatsAppMessage({
			to: from,
			body:
				"Sorry, result images could not be delivered right now.\n\n" +
				"Please try again in a few minutes, or contact the clinic directly."
		});
		return { handled: true };
	}

	let success = 0;
	let failCount = 0;

	for (let i = 0; i < mediaItems.length; i++) {
		const { url } = mediaItems[i];
		try {
			await sendWhatsAppMediaMessage({
				to: from,
				mediaUrl: url,
				body: i === 0 ? RESULTS_STATIC_CAPTION : undefined
			});
			success += 1;
			if (i < mediaItems.length - 1) {
				await sleep(SEND_DELAY_MS);
			}
		} catch (err) {
			failCount += 1;
			console.error("[resultsHandler] send failed", url, err?.message || err);
		}
	}

	if (success === 0) {
		await sendWhatsAppMessage({
			to: from,
			body: "Sorry, the result images could not be delivered right now. Please try again later."
		});
	} else if (failCount > 0) {
		await sendWhatsAppMessage({
			to: from,
			body: "Some result images failed to send. Please try again if you need the complete gallery."
		});
	}

	setSession(
		from,
		mergeSession(session, {
			resultsLastSentAt: now,
			resultsLastCategory: category,
			resultsLastMessageSid: messageSid || null
		})
	);

	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "results-handler",
			event: "results_sent",
			from,
			category,
			mediaMessagesAttempted: mediaItems.length,
			mediaMessagesSent: success,
			mediaMessagesFailed: failCount
		})
	);

	return { handled: true };
}
