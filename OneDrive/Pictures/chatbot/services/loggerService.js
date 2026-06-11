import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { supabase } from "../tasks/supabaseClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "..", "..", "logs");
const LOG_FILES = ["chatbot.log", "error.log", "api.log"];

function ensureLogDir() {
	if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
	for (const name of LOG_FILES) {
		const p = path.join(LOG_DIR, name);
		if (!fs.existsSync(p)) fs.writeFileSync(p, "", "utf8");
	}
}

function formatTimestamp(d = new Date()) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function appendFile(filename, block) {
	try {
		ensureLogDir();
		fs.appendFileSync(path.join(LOG_DIR, filename), block, "utf8");
	} catch (e) {
		console.error("[loggerService]", e?.message || e);
	}
}

function formatBlock(payload) {
	const ts = formatTimestamp();
	const dir =
		payload.direction === "inbound" ? "USER:" : payload.direction === "outbound" ? "ASSISTANT:" : "SYSTEM:";
	return [
		`[${ts}]`,
		"",
		dir,
		`Phone: ${payload.userPhone ?? "—"}`,
		payload.userName ? `Name: ${payload.userName}` : null,
		`Role: ${payload.userRole ?? "patient"}`,
		`Channel: ${payload.channel ?? "whatsapp"}`,
		payload.sessionId ? `Session: ${payload.sessionId}` : null,
		"",
		payload.direction === "inbound" ? "MESSAGE:" : "RESPONSE:",
		payload.message || "(empty)",
		"",
		payload.detectedIntent ? `INTENT:\n${payload.detectedIntent}` : null,
		payload.extractedEntities ? `ENTITY:\n${JSON.stringify(payload.extractedEntities)}` : null,
		payload.retrievedCrmData ? `CRM RECORDS:\n${JSON.stringify(payload.retrievedCrmData).slice(0, 2000)}` : null,
		payload.responseTimeMs != null ? `\nResponse Time: ${payload.responseTimeMs}ms` : null,
		payload.error ? `\nError Details: ${payload.error}` : null,
		"\n---\n"
	]
		.filter(Boolean)
		.join("\n");
}

export async function logChatEvent(payload) {
	ensureLogDir();
	const block = formatBlock(payload);
	appendFile("chatbot.log", block);
	if (payload.error) appendFile("error.log", block);
	if (payload.direction === "system") appendFile("api.log", block);

	const ownerId = String(process.env.SUPABASE_DEFAULT_OWNER_ID || "").trim() || null;
	const { error } = await supabase.from("chat_logs").insert({
		session_id: payload.sessionId ?? null,
		owner_id: ownerId,
		channel: payload.channel ?? "whatsapp",
		user_phone: payload.userPhone ?? null,
		user_name: payload.userName ?? null,
		user_role: payload.userRole ?? "patient",
		direction: payload.direction,
		message: payload.message ?? "",
		detected_intent: payload.detectedIntent ?? null,
		extracted_entities: payload.extractedEntities ?? {},
		retrieved_crm_data: payload.retrievedCrmData ?? {},
		final_response: payload.finalResponse ?? null,
		response_time_ms: payload.responseTimeMs ?? null,
		language: payload.language ?? "en",
		openai_used: payload.openaiUsed ?? false,
		error: payload.error ?? null
	});
	if (error) appendFile("error.log", `[${formatTimestamp()}] supabase: ${error.message}\n`);
}
