import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATIC_RESULT_IMAGES } from "./staticResults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_RESULTS_DIR = path.join(__dirname, "..", "public", "results");

/** Resolve HTTPS origin Twilio can GET (runtime — not import-time). */
export function getResultsMediaBaseUrl() {
	const explicit = String(process.env.RESULTS_MEDIA_BASE_URL || "").trim();
	if (explicit) return explicit.replace(/\/+$/, "");

	const appBase = String(
		process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || ""
	).trim();
	if (appBase && /^https:\/\//i.test(appBase)) {
		return appBase.replace(/\/+$/, "");
	}

	const publicWebhookUrl = String(process.env.PUBLIC_WEBHOOK_URL || "").trim();
	if (publicWebhookUrl) {
		try {
			return new URL(publicWebhookUrl).origin;
		} catch {
			// ignore
		}
	}
	return "";
}

/** Prefer Next API route (correct Content-Type); fallback to /results/ static. */
export function buildResultMediaUrls(baseUrl) {
	const base = String(baseUrl || "").replace(/\/+$/, "");
	return STATIC_RESULT_IMAGES.flatMap((file) => {
		const encoded = encodeURIComponent(file);
		return [
			`${base}/api/whatsapp/results/${encoded}`,
			`${base}/results/${encoded}`,
		];
	});
}

export function getPrimaryResultMediaUrls(baseUrl) {
	const base = String(baseUrl || "").replace(/\/+$/, "");
	return STATIC_RESULT_IMAGES.map(
		(file) => `${base}/api/whatsapp/results/${encodeURIComponent(file)}`
	);
}

export function getLocalResultFilePath(filename) {
	const safe = path.basename(filename);
	const filePath = path.join(LOCAL_RESULTS_DIR, safe);
	if (!fs.existsSync(filePath)) return null;
	return filePath;
}

/**
 * Twilio must receive image/* (not ngrok HTML). Returns first URL that passes HEAD/GET check.
 */
export async function resolveReachableMediaUrl(urls) {
	for (const url of urls) {
		const ok = await probeMediaUrl(url);
		if (ok) return url;
	}
	return null;
}

export async function probeMediaUrl(url) {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 12000);
		let res = await fetch(url, { method: "HEAD", signal: ctrl.signal, redirect: "follow" });
		clearTimeout(t);

		if (res.status === 405 || res.status === 404) {
			const ctrl2 = new AbortController();
			const t2 = setTimeout(() => ctrl2.abort(), 12000);
			res = await fetch(url, {
				method: "GET",
				headers: { Range: "bytes=0-1023" },
				signal: ctrl2.signal,
				redirect: "follow",
			});
			clearTimeout(t2);
		}

		if (!res.ok) {
			console.warn("[resultsMedia] probe failed status", url, res.status);
			return false;
		}

		const ct = String(res.headers.get("content-type") || "").toLowerCase();
		if (ct.includes("text/html")) {
			console.warn("[resultsMedia] probe got HTML not image (ngrok page?)", url);
			return false;
		}
		if (!ct.includes("image/")) {
			console.warn("[resultsMedia] probe unexpected content-type", url, ct);
			return false;
		}
		return true;
	} catch (e) {
		console.warn("[resultsMedia] probe error", url, e?.message || e);
		return false;
	}
}

/** One reachable URL per image file. */
export async function resolveAllResultMediaUrls(baseUrl) {
	const primary = getPrimaryResultMediaUrls(baseUrl);
	const resolved = [];

	for (let i = 0; i < STATIC_RESULT_IMAGES.length; i++) {
		const file = STATIC_RESULT_IMAGES[i];
		const candidates = [
			primary[i],
			`${String(baseUrl).replace(/\/+$/, "")}/results/${encodeURIComponent(file)}`,
		];
		const url = await resolveReachableMediaUrl(candidates);
		if (url) resolved.push({ file, url });
	}

	return resolved;
}
