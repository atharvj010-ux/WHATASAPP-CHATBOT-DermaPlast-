import { randomUUID } from "crypto";

const BASE_URL = String(process.env.LANGFUSE_BASE_URL || "https://us.cloud.langfuse.com").replace(/\/+$/, "");
const PUBLIC_KEY = String(process.env.LANGFUSE_PUBLIC_KEY || "").trim();
const SECRET_KEY = String(process.env.LANGFUSE_SECRET_KEY || "").trim();

const INGEST_URL = `${BASE_URL}/api/public/ingestion`;

function logLangfuse(action, detail = {}) {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "langfuse",
			action,
			...detail
		})
	);
}

function buildBasicAuthHeader() {
	const raw = `${PUBLIC_KEY}:${SECRET_KEY}`;
	const b64 = Buffer.from(raw, "utf8").toString("base64");
	return `Basic ${b64}`;
}

export async function trackLangfuseEvent(eventName, metadata = {}) {
	if (!PUBLIC_KEY || !SECRET_KEY) {
		logLangfuse("event_skipped", { eventName, reason: "missing_keys" });
		return null;
	}

	const traceId = randomUUID();
	const eventId = randomUUID();
	const nowIso = new Date().toISOString();

	// Use the legacy ingestion endpoint (batch) since it works reliably on Langfuse Cloud.
	// We create a trace per event to ensure they show up in your Langfuse tracing UI.
	const payload = {
		batch: [
			{
				id: eventId,
				timestamp: nowIso,
				type: "trace-create",
				body: {
					id: traceId,
					name: eventName,
					userId: metadata?.user ?? metadata?.userId ?? undefined,
					input: metadata?.message ?? metadata?.text ?? undefined,
					output: metadata?.reply ?? metadata?.response ?? undefined,
					sessionId: metadata?.sessionId ?? undefined,
					metadata,
					environment: "production"
				}
			}
		]
	};

	try {
		const resp = await fetch(INGEST_URL, {
			method: "POST",
			headers: {
				Authorization: buildBasicAuthHeader(),
				"Content-Type": "application/json",
				"x-langfuse-ingestion-version": "4"
			},
			body: JSON.stringify(payload)
		});

		if (!resp.ok) {
			const body = await resp.text().catch(() => "");
			logLangfuse("event_failed", {
				eventName,
				metadata,
				status: resp.status,
				error: body.slice(0, 800)
			});
			return null;
		}

		const data = await resp.json().catch(() => null);
		// Langfuse can return 207 for partial success; treat it as success when request succeeds.
		logLangfuse("event_sent", { eventName, traceId, status: resp.status, result: data });
		return data;
	} catch (error) {
		logLangfuse("event_error", { eventName, metadata, error: error?.message || String(error) });
		return null;
	}
}
