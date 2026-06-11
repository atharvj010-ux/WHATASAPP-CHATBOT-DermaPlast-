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

function normalizeUsage(usageMetadata) {
	if (!usageMetadata) return null;
	return {
		prompt_tokens: usageMetadata.promptTokenCount ?? null,
		completion_tokens: usageMetadata.candidatesTokenCount ?? null,
		total_tokens: usageMetadata.totalTokenCount ?? null
	};
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

	const payload = {
		contents: normalized.contents,
		generationConfig: {
			temperature,
			maxOutputTokens
		}
	};

	if (combinedSystemInstruction) {
		payload.systemInstruction = {
			parts: [{ text: combinedSystemInstruction }]
		};
	}

	if (responseMimeType) {
		payload.generationConfig.responseMimeType = responseMimeType;
	}

	const response = await fetch(
		`${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify(payload)
		}
	);

	const raw = await response.text();
	if (!response.ok) {
		throw new Error(`Gemini request failed (${response.status}): ${raw.slice(0, 500)}`);
	}

	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(`Gemini returned non-JSON response: ${raw.slice(0, 500)}`);
	}

	const text = String(
		data?.candidates?.[0]?.content?.parts
			?.map((part) => (typeof part?.text === "string" ? part.text : ""))
			.join("") || ""
	).trim();

	return {
		text,
		usage: normalizeUsage(data?.usageMetadata),
		raw: data,
		model
	};
}

export { DEFAULT_GEMINI_MODEL };