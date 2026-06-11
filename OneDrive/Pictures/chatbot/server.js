import "./loadEnv.js";
import express from "express";
import morgan from "morgan";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent, runCrmAssistant } from "./agent.js";
import { getSession, setSession } from "./store.js";
import { EMPTY_TWIML, handleInboundWhatsApp } from "./inbound.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set("trust proxy", true);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.use(
	express.urlencoded({
		extended: false,
		verify: (req, _res, buf) => {
			req.rawBody = buf.toString();
		}
	})
);
app.use(express.json());

const publicDir = path.join(__dirname, "public");
const resultsDir = path.join(publicDir, "results");

/** Twilio needs image/jpeg with a stable URL (before generic static). */
app.get("/results/:filename", (req, res) => {
	const filename = path.basename(String(req.params.filename || ""));
	if (!/^[\w.-]+\.(jpe?g|png|webp)$/i.test(filename)) {
		return res.status(400).send("Invalid file");
	}
	const filePath = path.join(resultsDir, filename);
	res.type(/\.png$/i.test(filename) ? "image/png" : "image/jpeg");
	res.sendFile(filePath, (err) => {
		if (err) {
			console.warn("[results-static] not found", filePath, err?.message);
			res.status(404).send("Not found");
		}
	});
});

app.get("/api/whatsapp/results/:filename", (req, res) => {
	const filename = path.basename(String(req.params.filename || ""));
	if (!/^[\w.-]+\.(jpe?g|png|webp)$/i.test(filename)) {
		return res.status(400).send("Invalid file");
	}
	const filePath = path.join(resultsDir, filename);
	res.type(/\.png$/i.test(filename) ? "image/png" : "image/jpeg");
	res.sendFile(filePath, (err) => {
		if (err) {
			console.warn("[results-api] not found", filePath, err?.message);
			res.status(404).send("Not found");
		}
	});
});

app.use(express.static(publicDir));

function validateStartupEnv() {
	const from = process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_WHATSAPP_NUMBER;
	const keys = {
		GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
		TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
		TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
		TWILIO_WHATSAPP_SENDER: !!from,
		PUBLIC_WEBHOOK_URL: !!String(process.env.PUBLIC_WEBHOOK_URL || "").trim()
	};
	const missing = Object.entries(keys)
		.filter(([, ok]) => !ok)
		.map(([k]) => k);
	console.log("[env] WhatsApp agent configuration:", keys);
	if (missing.length) {
		console.warn("[env] Missing or empty:", missing.join(", "));
	}
	if (from && String(from).includes("14155238886")) {
		console.warn(
			"[env] TWILIO_WHATSAPP_NUMBER looks like the Twilio Sandbox (+14155238886). Use your production WhatsApp Business sender (e.g. whatsapp:+919988046049)."
		);
	}
	return keys;
}

app.get("/", (_req, res) => {
	const indexPath = path.join(publicDir, "index.html");
	res.sendFile(indexPath, (err) => {
		if (err) {
			res.status(200).json({
				status: "ok",
				service: "dermaplast-whatsapp-agent",
				routes: {
					webhook: "/whatsapp",
					legacyWebhook: "/twilio/whatsapp",
					apiChat: "/api/chat",
					health: "/health"
				}
			});
		}
	});
});

app.get("/health", (_req, res) => {
	const env = validateStartupEnv();
	res.status(200).json({
		status: "ok",
		service: "dermaplast-whatsapp-agent",
		envOk: env,
		routes: {
			webhook: "/whatsapp",
			legacyWebhook: "/twilio/whatsapp",
			apiChat: "/api/chat"
		}
	});
});

app.post("/api/chat", async (req, res) => {
	const t0 = Date.now();
	try {
		const from = (req.body?.from || req.ip || "web").toString();
		const text = (req.body?.text || req.body?.message || "").toString().trim();
		const channel = String(req.body?.channel || "").trim().toLowerCase();

		if (!text) return res.status(400).json({ error: "Missing text" });

		const session = getSession(from);
		const authHeader = String(req.headers.authorization || "");
		const accessToken = authHeader.toLowerCase().startsWith("bearer ")
			? authHeader.slice(7).trim()
			: "";

		const runner =
			channel === "crm-widget"
				? runCrmAssistant({ from, userText: text, session, accessToken })
				: runAgent({ from, userText: text, session });

		const { reply, newSession } = await runner;
		setSession(from, newSession);

		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "whatsapp-webhook",
				event: "api_chat",
				from,
				clientChannel: channel || "whatsapp",
				ms: Date.now() - t0,
				chars: (reply || "").length
			})
		);
		res.status(200).json({ reply, from, channel: channel || "whatsapp", ms: Date.now() - t0 });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: "server error" });
	}
});

app.get("/debug/ping", (_req, res) => {
	res.status(200).json({ status: "ok", message: "debug ping" });
});

async function handleWhatsAppWebhook(req, res) {
	try {
		const result = await handleInboundWhatsApp({ body: req.body, req });
		res.status(result.status).type(result.contentType).send(result.body);
		if (result.queued && result.runAsyncWork) {
			void result.runAsyncWork();
		}
	} catch (err) {
		console.error("Webhook error:", err);
		if (!res.headersSent) {
			res.status(200).type("text/xml").send(EMPTY_TWIML);
		}
	}
}

app.post("/whatsapp", handleWhatsAppWebhook);
app.post("/twilio/whatsapp", handleWhatsAppWebhook);
app.post("/webhook", handleWhatsAppWebhook);

app.use((req, res) => {
	res.status(404).json({
		error: "not_found",
		path: req.originalUrl,
		method: req.method,
		available: ["/", "/health", "/api/chat", "/whatsapp", "/twilio/whatsapp", "/webhook"]
	});
});

app.use((err, _req, res, next) => {
	console.error("Unhandled error:", err);
	if (res.headersSent) {
		return next(err);
	}
	res.status(500).json({ error: "internal_server_error" });
});

const port = Number(process.env.PORT || 3000);

function listenOnAvailablePort(startPort) {
	const server = http.createServer(app);

	server.on("error", (err) => {
		if (err && err.code === "EADDRINUSE") {
			console.warn(`Port ${startPort} is already in use. Trying ${startPort + 1}...`);
			return listenOnAvailablePort(startPort + 1);
		}
		console.error("Server failed to start:", err);
		process.exit(1);
	});

	server.listen(startPort, () => {
		const url = `http://localhost:${startPort}`;
		console.log(`WhatsApp agent listening on ${url}`);
		validateStartupEnv();
		const pub = String(process.env.PUBLIC_WEBHOOK_URL || "").trim();
		if (pub) {
			console.log(`Configure Twilio inbound webhook (POST): ${pub}`);
		} else {
			console.warn(
				"[env] Set PUBLIC_WEBHOOK_URL to your public HTTPS webhook (e.g. https://your-app.vercel.app/api/twilio/whatsapp or https://<tunnel>/whatsapp)."
			);
		}
	});
}

listenOnAvailablePort(port);
