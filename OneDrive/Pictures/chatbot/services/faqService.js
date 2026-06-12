import { generateGeminiContent, DEFAULT_GEMINI_MODEL } from "./geminiService.js";
import { trackLangfuseEvent } from "./langfuseService.js";

const FAQ_ITEMS = [
	{
		key: "location",
		match: /(where.*clinic)|(clinic.*located)|(address)/i,
		answer:
			"Dermaplast Aesthetic Clinic is located in Panvel/Navi Mumbai. Please contact the clinic for the exact address and directions."
	},
	{
		key: "timings",
		match: /(timings?|hours|open|close)/i,
		answer:
			"Our clinic is usually open from 10:00 AM to 7:00 PM. Please confirm availability before visiting."
	},
	{
		key: "gfc",
		match: /\bgfc\b/i,
		answer:
			"GFC stands for Growth Factor Concentrate. It is a hair treatment that uses growth factors from your own blood to help reduce hair fall and improve hair density."
	},
	{
		key: "prp",
		match: /\bprp\b/i,
		answer:
			"PRP stands for Platelet-Rich Plasma. It is commonly used for hair fall and skin rejuvenation treatments."
	},
	{
		key: "acne",
		match: /acne treatment/i,
		answer: "Acne treatment at Dermaplast includes medical-grade cleansers, peels, and targeted laser therapies tailored to your skin type."
	},
	{
		key: "transplant",
		match: /hair transplant/i,
		answer:
			"Our hair transplant consultations cover FUE/ FUT options, scalp mapping, and personalised planning for natural growth."
	},
	{
		key: "cost",
		match: /(cost|price|fee|charges|how much)/i,
		answer:
			"Costs vary by treatment and consultation. Please WhatsApp us or call the clinic for the latest pricing, or request a callback."
	},
	{
		key: "consultation",
		match: /skin consultation/i,
		answer:
			"Yes, we offer skin consultations to assess your concerns, recommend treatments, and plan a follow-up."
	},
	{
		key: "treatments",
		match: /(treatments|services)/i,
		answer:
			"We provide treatments such as Hair GFC, PRP, Hair Transplant consultation, Acne Treatment, Skin Consultation, Laser Hair Removal, Anti-aging treatments, and other aesthetic procedures."
	}
];

const SAFE_DEFAULT = "Please contact the clinic directly for this information.";

function findLocalFaq(answerText) {
	if (!answerText) return null;
	const text = String(answerText || "").toLowerCase();
	for (const item of FAQ_ITEMS) {
		if (item.match.test(text)) {
			return item.answer;
		}
	}
	return null;
}

async function queryGemini(question) {
	try {
		const response = await generateGeminiContent({
			model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
			messages: [
				{
					role: "system",
					content:
						"You are the Dermaplast Aesthetic Clinic receptionist. Provide concise, friendly answers to clinic questions."
				},
				{
					role: "user",
					content: `FAQ: """${question}"""`
				}
			],
			temperature: 0.2,
			maxOutputTokens: 200
		});
		return response.text;
	} catch (error) {
		console.error("[faqService] Gemini error", error?.message || error);
		return null;
	}
}

export async function answerFaq(question) {
	const local = findLocalFaq(question);
	if (local) {
		await trackLangfuseEvent("faq.answer", { question, source: "local" });
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "faq-service",
				event: "local-answer",
				question
			})
		);
		return { source: "local", answer: local };
	}

	if (!process.env.GEMINI_API_KEY) {
		await trackLangfuseEvent("faq.answer", { question, source: "fallback_missing_key" });
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "faq-service",
				event: "fallback-no-key",
				question
			})
		);
		return { source: "fallback", answer: SAFE_DEFAULT };
	}

	const geminiAnswer = await queryGemini(question);
	if (geminiAnswer) {
		await trackLangfuseEvent("faq.answer", { question, source: "gemini" });
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "faq-service",
				event: "gemini-answer",
				question
			})
		);
		return { source: "gemini", answer: geminiAnswer };
	}

	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "faq-service",
			event: "fallback-default",
			question
		})
	);
	await trackLangfuseEvent("faq.answer", { question, source: "fallback_default" });
	return { source: "fallback", answer: SAFE_DEFAULT };
}
