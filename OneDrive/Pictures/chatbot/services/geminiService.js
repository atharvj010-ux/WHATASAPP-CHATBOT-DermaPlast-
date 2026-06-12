const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function mustHaveEnv(name) {
	if (!process.env[name]) throw new Error(`Missing ${name}`);
}

function normalizeText(content) {
	if (content == null) return "";
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part?.text === "string" ? part.text : typeof part === "string" ? part : ""))
			.filter(Boolean)
			.join("\n")
			.trim();
	}
	return String(content).trim();
}

function normalizeMessages(messages = []) {
	const contents = [];
	const systemParts = [];

	for (const message of messages) {
		const text = normalizeText(message?.content);
		if (!text) continue;

		if (message.role === "system") {
			systemParts.push(text);
			continue;
		}

		contents.push({
			role: message.role === "assistant" ? "model" : "user",
			parts: [{ text }]
		});
	}

	return {
		contents,
		systemInstruction: systemParts.length ? systemParts.join("\n\n") : null
	};
}

function normalizeUsage(usageInfo) {
	if (!usageInfo) return null;
	return {
		prompt_tokens: usageInfo.promptTokenCount ?? usageInfo.promptTokens ?? null,
		completion_tokens: usageInfo.candidatesTokenCount ?? usageInfo.completionTokens ?? null,
		total_tokens: usageInfo.totalTokenCount ?? usageInfo.totalTokens ?? null
	};
}

function extractGeminiReplyText(data) {
	const parts = data?.candidates?.[0]?.content?.parts;
	if (Array.isArray(parts) && parts.length) {
		return parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("").trim();
	}
	const output = data?.candidates?.[0]?.output;
	if (typeof output === "string") {
		return output.trim();
	}
	return "";
}

function buildPromptMessages(normalizedContents, combinedSystemInstruction) {
	const messages = [];
	if (combinedSystemInstruction) {
		messages.push({
			role: "system",
			content: [{ type: "text", text: combinedSystemInstruction }]
		});
	}
	for (const entry of normalizedContents) {
		const role = entry.role === "model" ? "assistant" : entry.role;
		const parts = (entry.parts || [])
			.map((part) => String(part?.text || "").trim())
			.filter(Boolean);
		if (!parts.length) continue;
		messages.push({
			role,
			content: parts.map((text) => ({ type: "text", text }))
		});
	}
	if (!messages.length) {
		messages.push({
			role: "user",
			content: [{ type: "text", text: "" }]
		});
	}
	return messages;
}

const ACTION_CONFIGS = [
	{
		name: "generateContent",
		buildPayload: ({ normalized, combinedSystemInstruction, temperature, maxOutputTokens, responseMimeType }) => {
			const payload = {
				contents: normalized.contents,
				generationConfig: {
					temperature,
					maxOutputTokens
				}
			};
			if (responseMimeType) {
				payload.generationConfig.responseMimeType = responseMimeType;
			}
			if (combinedSystemInstruction) {
				payload.systemInstruction = {
					parts: [{ text: combinedSystemInstruction }]
				};
			}
			return payload;
		}
	},
	{
		name: "generateText",
		buildPayload: ({ normalized, combinedSystemInstruction, temperature, maxOutputTokens }) => {
			return {
				prompt: {
					messages: buildPromptMessages(normalized.contents, combinedSystemInstruction)
				},
				temperature,
				maxOutputTokens
			};
		}
	}
];

function buildGeminiUrl(model, action, apiKey) {
	return `${GEMINI_API_BASE}/${encodeURIComponent(model)}:${action}?key=${encodeURIComponent(apiKey)}`;
}

async function callGeminiAction({ model, action, payload, apiKey }) {
	const response = await fetch(buildGeminiUrl(model, action, apiKey), {
		method: "POST",
		headers: {
			"Content-Type": "application/json"
		},
		body: JSON.stringify(payload)
	});

	const raw = await response.text();
	if (!response.ok) {
		return { ok: false, status: response.status, raw };
	}

	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(`Gemini returned non-JSON response: ${raw.slice(0, 500)}`);
	}

	return { ok: true, data };
}

export async function generateGeminiContent({
	model = DEFAULT_GEMINI_MODEL,
	systemInstruction,
	messages = [],
	temperature = 0.2,
	maxOutputTokens = 256,
	responseMimeType = null
} = {}) {
	mustHaveEnv("GEMINI_API_KEY");

	const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
	const normalized = normalizeMessages(messages);
	const combinedSystemInstruction = [systemInstruction, normalized.systemInstruction]
		.filter(Boolean)
		.join("\n\n")
		.trim();

	let lastError = null;
	for (const config of ACTION_CONFIGS) {
		const payload = config.buildPayload({
			normalized,
			combinedSystemInstruction,
			temperature,
			maxOutputTokens,
			responseMimeType
		});
		const result = await callGeminiAction({ model, action: config.name, payload, apiKey });
		if (result.ok) {
			return {
				text: extractGeminiReplyText(result.data),
				usage: normalizeUsage(result.data?.usageMetadata ?? result.data?.usage),
				raw: result.data,
				model
			};
		}

		const err = new Error(`Gemini ${config.name} request failed (${result.status}): ${result.raw.slice(0, 500)}`);
		lastError = err;
		const fallbackAllowed =
			config.name === "generateContent" &&
			result.status === 404 &&
			String(result.raw || "").toLowerCase().includes("generatecontent");
		if (fallbackAllowed) {
			console.warn(`[gemini] ${model} does not support ${config.name}; trying next action`);
			continue;
		}
		throw err;
	}

	throw lastError || new Error("Gemini request failed");
}

export { DEFAULT_GEMINI_MODEL };