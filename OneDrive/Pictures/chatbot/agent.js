import {
	lookupRestaurantFaq,
	handoffToHumanStub,
	matchFaqSync,
	normalizeWhatsAppFormatting,
	getCrmContextFromToken,
	fetchCrmToolData
} from "./tools.js";
import { buildDeterministicCrmReply } from "./crmReplies.js";
import { formatTaskEmptyMessage, formatTaskListReply } from "./taskQuery.js";
import { isWithinBusinessHours } from "./bizHours.js";
import {
	buildClinicTimingsReply,
	buildClinicContactReply,
	buildGeneralFallbackReply,
	buildAppointmentBookingGuidance,
	buildTreatmentInterestReply,
	buildPricingReply,
	buildFollowUpTaskGuidanceReply,
	isExplicitCrmAppointmentCommand
} from "./crm/crmIntegration.js";
import {
	isGreetingMessage,
	isPricingMessage,
	isGenericTreatmentInquiry,
	resolveBlockedTopicReply,
	buildLocalizedGreeting
} from "./crm/receptionistReplies.js";
import {
	isTreatmentEducationQuery,
	generateTreatmentEducationReply
} from "./crm/treatmentEducation.js";
import {
	resolveSessionLanguage,
	detectGreetingLanguage,
	languageLabel
} from "./crm/language.js";
import { classifyInboundIntent, isExplicitCrmTaskCommand } from "./crm/intents.js";
import { getClinicTimezone } from "./clinicTimezone.js";
import { generateGeminiContent, DEFAULT_GEMINI_MODEL } from "./services/geminiService.js";
import { trackLangfuseEvent } from "./services/langfuseService.js";

const MAX_HISTORY_MESSAGES = 8;
const FALLBACK_REPLY =
	"We’re having a brief technical issue. Please try again in a moment, or call the clinic directly and we’ll help you right away.";

async function safeTrack(eventName, metadata) {
	try {
		await trackLangfuseEvent(eventName, metadata ?? {});
	} catch (e) {
		// Never break the chatbot because Langfuse fails.
	}
}

function mustHaveEnv(name) {
	if (!process.env[name]) throw new Error(`Missing ${name}`);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function withRetries(fn, { tries = 3, label = "openai" } = {}) {
	let last;
	for (let i = 0; i < tries; i++) {
		const t0 = Date.now();
		try {
			const out = await fn();
			const ms = Date.now() - t0;
			if (ms > 2500) console.log(`[${label}] completed in ${ms}ms`);
			return out;
		} catch (e) {
			last = e;
			console.warn(`[${label}] attempt ${i + 1}/${tries} failed:`, e?.message || e);
			if (i < tries - 1) await sleep(350 * (i + 1));
		}
	}
	throw last;
}

function trimHistory(session) {
	if (session.history.length > MAX_HISTORY_MESSAGES) {
		session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
	}
}

function out(reply, session) {
	trimHistory(session);
	return { reply: normalizeWhatsAppFormatting(reply), newSession: session };
}

/** Clinic branding: CLINIC_* overrides legacy RESTAURANT_* env names. */
function clinicContext() {
	return {
		name: process.env.CLINIC_NAME || process.env.RESTAURANT_NAME || "DermaplastCRM Clinic",
		phone: process.env.CLINIC_PHONE || process.env.RESTAURANT_PHONE || "N/A",
		address: process.env.CLINIC_ADDRESS || process.env.RESTAURANT_ADDRESS || "N/A",
		tz: getClinicTimezone()
	};
}

function buildDermaplastPersonaBlock(info, lang) {
	const replyLang = languageLabel(lang);
	return [
		`You are ${info.name}'s WhatsApp clinic receptionist — not a medical consultant.`,
		`Always reply in ${replyLang} only. Do not switch language unless the user does.`,
		"Help with: greetings, clinic timings, address, contact, appointment booking format, follow-up task format.",
		"Never give: treatment procedures, medical advice, outcomes, pricing, packages, discounts, or estimated costs.",
		"For treatment or pricing questions, briefly encourage an in-person consultation and share clinic contact.",
		"Keep replies short (a few lines). Tone: polite, brief, professional. Never say you are an AI unless asked.",
		"CRM commands (Book appointment for… / Create follow-up task for…) are handled separately — do not invent bookings.",
		`Clinic: ${info.name} | Phone: ${info.phone} | Address: ${info.address}`
	].join(" ");
}

function buildFormattingRules() {
	return [
		"WhatsApp formatting (critical):",
		"- First line: short title (plain text, no markdown #).",
		"- Blank line, then body.",
		"- Bullets: each line starts with \"• \" (space after bullet). Blank line before bullet list.",
		"- Never split words with spaces (write PRP, medication, appointment, consultation as single words).",
		"- Short paragraphs; no wall of text."
	].join("\n");
}

function logIntentDebug(data) {
	try {
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "intent-router",
				...data
			})
		);
	} catch {
		// no-op
	}
}

function classifyWhatsappIntent(userText) {
	const t = String(userText || "").toLowerCase().trim();
	const has = (re) => re.test(t);

	if (isGreetingMessage(userText)) return "greeting_query";
	if (
		has(/\b(timing|timings|hours|working hours|open today|close today|open now|sunday open|when.*open|what time.*open)\b/) ||
		/(वेळ|समय|खुला|बंद|टाइमिंग|किती वाजता)/i.test(userText)
	) {
		return "timing_query";
	}
	if (isPricingMessage(userText)) return "pricing_query";
	if (isExplicitCrmAppointmentCommand(userText)) return "appointment_query";
	if (has(/\b(book|booking|appointment|consultation|schedule|slot|doctor available|availability|how can i book)\b/)) {
		return "appointment_query";
	}
	if (
		has(/\b(clinic|address|location|where are you|contact|phone number|branch)\b/) ||
		/(पत्ता|पता|संपर्क|क्लिनिक कुठे|कहाँ है|कुठे आहे|फोन नंबर)/i.test(userText)
	) {
		return "clinic_query";
	}
	if (has(/\b(follow[\s-]?up|followup|callback|call back|reminder)\b/) && !isExplicitCrmTaskCommand(userText)) {
		return "followup_query";
	}
	if (isTreatmentEducationQuery(userText)) return "treatment_education_query";
	if (isGenericTreatmentInquiry(userText)) return "treatment_query";
	return "fallback_query";
}

function fallbackClarificationReply(lang) {
	return buildGeneralFallbackReply(lang);
}

function missingAppointmentFields(draft) {
	const missing = [];
	if (!draft.treatment) missing.push("treatment");
	if (!draft.date) missing.push("date");
	if (!draft.time) missing.push("time");
	if (!draft.name) missing.push("name");
	if (!draft.phone) missing.push("phone");
	return missing;
}

function isAppointmentComplete(draft) {
	return missingAppointmentFields(draft).length === 0;
}

function nextAppointmentQuestion(missing) {
	const field = missing[0];

	switch (field) {
		case "treatment":
			return "Which treatment are you interested in (or say “not sure” and we’ll guide you)?";
		case "date":
			return "What day works best for you — today, tomorrow, or another date?";
		case "time":
			return "What time would you prefer?";
		case "name":
			return "May I have your full name for the appointment?";
		case "phone":
			return "What’s the best phone number to reach you on?";
		default:
			return "Could you share a bit more detail so I can help?";
	}
}

async function extractAppointmentFields({ model, userText }) {
	const tz = getClinicTimezone();

	const extractorSystem = `
Extract consultation appointment details from the user's message.
Return JSON only:
{
  "treatment": string|null,
  "date": "YYYY-MM-DD"|null,
  "time": "HH:mm"|null,
  "name": string|null,
  "phone": string|null,
  "notes": string|null,
  "cancel": boolean
}
Rules:
- If user wants to cancel/stop the booking, set cancel=true.
- If no value present, use null.
- Interpret relative dates like "today", "tonight", "this evening", "tomorrow" using timezone: ${tz}.
- Convert times like "7pm" to 24-hour "19:00".
- If the user says "this evening" and provides a time, treat date as today.
- treatment: short label (e.g. "hair transplant", "HydraFacial", "dental whitening").
`.trim();

	const extraction = await withRetries(
		() =>
			generateGeminiContent({
				model,
				temperature: 0.1,
				maxOutputTokens: 220,
				messages: [
					{ role: "system", content: extractorSystem },
					{ role: "user", content: userText }
				],
				responseMimeType: "application/json"
			}),
		{ label: "gemini.extract" }
	);

	const eu = extraction.usage;
	if (eu) {
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "gemini",
				step: "extract",
				model,
				prompt_tokens: eu.prompt_tokens,
				completion_tokens: eu.completion_tokens,
				total_tokens: eu.total_tokens
			})
		);
	}

	try {
		return JSON.parse(extraction.choices[0].message.content);
	} catch {
		return {};
	}
}

function mergeAppointmentDraft(draft, parsed) {
	const next = { ...draft };
	for (const key of ["treatment", "date", "time", "name", "phone", "notes"]) {
		const v = parsed?.[key];
		if (v !== null && v !== undefined && v !== "") next[key] = v;
	}
	return next;
}

function buildPlannerSystem(info, withinHours, lang) {
	return [
		buildDermaplastPersonaBlock(info, lang),
		buildFormattingRules(),
		"Answer only what user asked. Never return clinic timings for treatment questions.",
		"Route the conversation. Return JSON only:",
		'{ "intent": "FAQ"|"RESERVATION"|"HANDOFF"|"GENERAL", "startReservation": boolean, "startHandoff": boolean, "faqQuery": string|null, "handoffSummary": string|null, "reply": string }',
		"Rules:",
		"- Never start RESERVATION flows; appointments are created only via CRM command format.",
		"- Never provide treatment details, medical advice, or pricing in \"reply\".",
		"- HANDOFF / startHandoff: user wants a human, doctor, or specialist.",
		"- FAQ / faqQuery: only clinic hours, address, contact — not treatment or pricing.",
		"- GENERAL: brief receptionist-style reply; encourage clinic visit for treatment/pricing.",
		`Clinic staff availability (handoff messaging): ${withinHours ? "AVAILABLE" : "NOT_AVAILABLE"}.`
	].join("\n");
}

async function routeIntentReply({ from, userText, session, model, info, intent, lang }) {
	if (intent === "greeting_query") {
		const greetLang = detectGreetingLanguage(userText);
		session.preferredLanguage = greetLang;
		return out(buildLocalizedGreeting(greetLang), session);
	}

	if (intent === "timing_query") {
		return out(buildClinicTimingsReply(lang), session);
	}

	if (intent === "clinic_query") {
		return out(buildClinicContactReply(lang), session);
	}

	if (intent === "pricing_query") {
		return out(buildPricingReply(lang), session);
	}

	if (intent === "appointment_query") {
		return out(buildAppointmentBookingGuidance(lang), session);
	}

	if (intent === "followup_query") {
		return out(buildFollowUpTaskGuidanceReply(), session);
	}

	if (intent === "treatment_education_query") {
		const reply = await generateTreatmentEducationReply({
			userText,
			lang,
			model
		});
		return out(reply, session);
	}

	if (intent === "treatment_query") {
		return out(buildTreatmentInterestReply(lang), session);
	}

	if (intent === "fallback_query") {
		const blocked = resolveBlockedTopicReply(userText, lang);
		if (blocked) return out(blocked, session);
		return out(fallbackClarificationReply(lang), session);
	}

	return null;
}

export async function runAgent({ from, userText, session }) {
	try {
		return await runAgentInner({ from, userText, session });
	} catch (err) {
		console.error("[agent] fatal:", err);
		return out(FALLBACK_REPLY, session);
	}
}

async function runAgentInner({ from, userText, session }) {
	let traced = false;
	const traceEnd = async () => {
		if (traced) return;
		traced = true;
		await safeTrack("trace_end", { user: from, message: String(userText || "") });
	};

	mustHaveEnv("GEMINI_API_KEY");
	const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
	const info = clinicContext();
	const lang = resolveSessionLanguage(session, userText);

	// Step events (used for easier Langfuse browsing/debugging).
	await safeTrack("user_question", {
		user: from,
		message: String(userText || "")
	});

	const blockedReply = resolveBlockedTopicReply(userText, lang);
	if (blockedReply) {
		logIntentDebug({
			from,
			responseCategory: isPricingMessage(userText) ? "pricing_query_hard" : "treatment_query_hard"
		});
		session.history.push({ role: "user", content: userText }, { role: "assistant", content: blockedReply });
		await traceEnd();
		return out(blockedReply, session);
	}

	if (isTreatmentEducationQuery(userText)) {
		await safeTrack("entity_extraction", {
			user: from,
			message: String(userText || ""),
			context: "treatment_education_query"
		});
		const eduReply = await generateTreatmentEducationReply({
			userText,
			lang,
			model
		});
		logIntentDebug({ from, responseCategory: "treatment_education_query" });
		session.history.push({ role: "user", content: userText }, { role: "assistant", content: eduReply });
		await traceEnd();
		return out(eduReply, session);
	}

	if (session.flow === "RESERVATION") {
		session.flow = null;
		session.reservationDraft = {};
		await traceEnd();
		return out(buildAppointmentBookingGuidance(lang), session);
	}

	logIntentDebug({ from, message: userText, preferredLanguage: lang });
	const inboundIntent = classifyInboundIntent(userText);
	const intent = classifyWhatsappIntent(userText);
	logIntentDebug({ from, inboundIntent, detectedIntent: intent, preferredLanguage: lang });

	await safeTrack("intent_detection", {
		user: from,
		message: String(userText || ""),
		inboundIntent,
		intent
	});

	const routed = await routeIntentReply({
		from,
		userText,
		session,
		model,
		info,
		intent,
		lang
	});
	if (routed) {
		logIntentDebug({ from, responseCategory: intent });
		session.history.push({ role: "user", content: userText }, { role: "assistant", content: routed.reply });
		await traceEnd();
		return routed;
	}

	if (!isPricingMessage(userText) && !isGenericTreatmentInquiry(userText)) {
		const faqInstant = matchFaqSync(userText);
		if (faqInstant) {
			logIntentDebug({ from, responseCategory: "faq_fallback" });
			session.history.push({ role: "user", content: userText }, { role: "assistant", content: faqInstant });
			await safeTrack("final_response", { user: from, message: String(userText || ""), reply: faqInstant });
			await traceEnd();
			return out(faqInstant, session);
		}
	}

	const withinHours = isWithinBusinessHours();
	trimHistory(session);
	const history = session.history.slice(-6);

	const system = buildPlannerSystem(info, withinHours, lang);

	const decision = await withRetries(
		() =>
			generateGeminiContent({
				model,
				temperature: 0.35,
				maxOutputTokens: 450,
				messages: [
					{ role: "system", content: system },
					...history,
					{ role: "user", content: userText }
				],
				responseMimeType: "application/json"
			}),
		{ label: "gemini.planner" }
	);

	// Planner generation is a key LLM step.
	await safeTrack("llm_response_validation", {
		user: from,
		message: String(userText || ""),
		// include a hint that we reached the planner stage
		context: "planner_generation_completed"
	});

	const pu = decision.usage;
	if (pu) {
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				channel: "gemini",
				step: "planner",
				model,
				prompt_tokens: pu.prompt_tokens,
				completion_tokens: pu.completion_tokens,
				total_tokens: pu.total_tokens
			})
		);
	}

	let plan;
	try {
		plan = JSON.parse(decision.choices[0].message.content);
	} catch {
		plan = {
			intent: "GENERAL",
			startReservation: false,
			startHandoff: false,
			faqQuery: null,
			handoffSummary: null,
			reply: "Could you rephrase that?"
		};
	}

	await safeTrack("llm_prompt_response_validation", {
		user: from,
		message: String(userText || ""),
		context: "planner_json_parsed"
	});

	if (isPricingMessage(userText)) {
		return out(buildPricingReply(lang), session);
	}
	if (isGenericTreatmentInquiry(userText)) {
		return out(buildTreatmentInterestReply(lang), session);
	}
	if (isTreatmentEducationQuery(userText)) {
		const eduReply = await generateTreatmentEducationReply({ userText, lang, model });
		session.history.push({ role: "user", content: userText }, { role: "assistant", content: eduReply });
		return out(eduReply, session);
	}

	if (plan.intent === "FAQ" || plan.faqQuery) {
		const answer = await lookupRestaurantFaq({ question: plan.faqQuery || userText });
		if (answer && !isPricingMessage(userText) && !isGenericTreatmentInquiry(userText)) {
			await safeTrack("final_response", {
				user: from,
				message: String(userText || ""),
				reply: answer
			});
			session.history.push({ role: "user", content: userText }, { role: "assistant", content: answer });
			await traceEnd();
			return out(answer, session);
		}
	}

	if (plan.startReservation || plan.intent === "RESERVATION") {
		const reply = buildAppointmentBookingGuidance(lang);
		await safeTrack("final_response", {
			user: from,
			message: String(userText || ""),
			reply
		});
		session.history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
		await traceEnd();
		return out(reply, session);
	}

	if (plan.startHandoff || plan.intent === "HANDOFF") {
		const summary = plan.handoffSummary || userText;
		const result = await handoffToHumanStub({ from, summary });

		const reply = result.available
			? `Team handoff\n\nThank you — I’m connecting you with our team now. Please add any details here and we’ll follow up shortly.\n\n• Ref: ${result.handoffId}`
			: `Team handoff\n\nWe’re currently outside live clinic hours. I can take a message and our team will respond when we’re open.\n\n• Ref: ${result.handoffId}\n\nWhat should I pass along?`;

		session.history.push({ role: "user", content: userText }, { role: "assistant", content: reply });

		return out(reply, session);
	}

	let reply =
		typeof plan.reply === "string" && plan.reply.trim()
			? plan.reply.trim()
			: buildGeneralFallbackReply(lang);

	const blockedFinal = resolveBlockedTopicReply(userText, lang);
	if (blockedFinal) reply = blockedFinal;

	session.history.push({ role: "user", content: userText }, { role: "assistant", content: reply });

	return out(reply, session);
}

const MONTH_NAME_INDEX = {
	january: 0,
	february: 1,
	march: 2,
	april: 3,
	may: 4,
	june: 5,
	july: 6,
	august: 7,
	september: 8,
	october: 9,
	november: 10,
	december: 11
};

function addDays(date, amount) {
	const next = new Date(date);
	next.setDate(next.getDate() + amount);
	return next;
}

function toDayBoundary(date, type) {
	const d = new Date(date);
	if (type === "start") {
		d.setHours(0, 0, 0, 0);
	} else {
		d.setHours(23, 59, 59, 999);
	}
	return d;
}

function toIso(date) {
	return date ? new Date(date).toISOString() : null;
}

function parseSpecificDate(text) {
	const dayMonth = /(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|\bjan\b|\bfeb\b|\bmar\b|\bapr\b|\bjun\b|\bjul\b|\baug\b|\bsep\b|\boct\b|\bnov\b|\bdec\b)(?:\s+(\d{4}))?/i;
	const monthDay = /(january|february|march|april|may|june|july|august|september|october|november|december|\bjan\b|\bfeb\b|\bmar\b|\bapr\b|\bjun\b|\bjul\b|\baug\b|\bsep\b|\boct\b|\bnov\b|\bdec\b)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?/i;
	let match = text.match(dayMonth);
	let day;
	let monthToken;
	let year;

	if (match) {
		day = Number(match[1]);
		monthToken = match[2];
		year = match[3] ? Number(match[3]) : new Date().getFullYear();
	} else {
		match = text.match(monthDay);
		if (!match) return null;
		monthToken = match[1];
		day = Number(match[2]);
		year = match[3] ? Number(match[3]) : new Date().getFullYear();
	}

	const month = MONTH_NAME_INDEX[monthToken.toLowerCase()] ?? null;
	if (month === null || Number.isNaN(day)) return null;

	return new Date(year, month, day);
}

function formatDateLabel(date) {
	if (!date) return null;
	const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return `${date.getDate()} ${monthNames[date.getMonth()]}`;
}

function parseNaturalDateRange(text) {
	const now = new Date();
	const lower = text.toLowerCase();
	if (/\btoday\b/.test(lower)) {
		return {
			range: {
				from: toIso(toDayBoundary(now, "start")),
				to: toIso(toDayBoundary(now, "end"))
			},
			label: "today",
			mode: "today"
		};
	}

	if (/\btomorrow\b/.test(lower)) {
		const target = addDays(now, 1);
		return {
			range: {
				from: toIso(toDayBoundary(target, "start")),
				to: toIso(toDayBoundary(target, "end"))
			},
			label: "tomorrow",
			mode: "tomorrow"
		};
	}

	if (/\bnext week\b/.test(lower)) {
		const from = addDays(toDayBoundary(now, "start"), 1);
		const to = addDays(toDayBoundary(now, "end"), 7);
		return {
			range: {
				from: toIso(from),
				to: toIso(to)
			},
			label: "next week",
			mode: "nextWeek"
		};
	}

	const explicit = parseSpecificDate(text);
	if (explicit) {
		return {
			range: {
				from: toIso(toDayBoundary(explicit, "start")),
				to: toIso(toDayBoundary(explicit, "end"))
			},
			label: formatDateLabel(explicit),
			mode: "specific"
		};
	}

	if (/\bupcoming\b/.test(lower)) {
		const from = toDayBoundary(now, "start");
		const to = addDays(from, 30);
		return {
			range: {
				from: toIso(from),
				to: toIso(to)
			},
			label: "upcoming",
			mode: "upcoming"
		};
	}

	return null;
}

function normalizeNameCandidate(raw, allowSingleWord = false) {
	if (!raw) return null;
	let cleaned = raw.trim().replace(/[\.,\?\!]+/g, "");
	const stopWords = new Set([
		"today",
		"tomorrow",
		"tasks",
		"task",
		"appointment",
		"appointments",
		"details",
		"history",
		"billing",
		"invoices",
		"invoice",
		"payments",
		"payment",
		"join",
		"register",
		"clinic",
		"medical",
		"pending",
		"upcoming",
		"next",
		"followup",
		"follow-up",
		"today's",
		"tomorrow's",
		"my",
		"mine",
		"the"
	]);
	const parts = [];
	for (const part of cleaned.split(/\s+/)) {
		if (!part) continue;
		if (stopWords.has(part.toLowerCase())) break;
		parts.push(part);
		if (parts.length >= 4) break;
	}

	if (parts.length >= 2) {
		return parts.join(" ");
	}

	if (allowSingleWord && parts.length === 1) {
		return parts[0];
	}

	return null;
}

function extractPatientName(text) {
	const patterns = [
		/(?:give\s+)?details?\s+(?:of|for)\s+(.+?)(?:\?|$)/i,
		/(?:show|get)\s+(.+?)(?:'s|’s)\s+(?:pending\s+)?(?:invoices?|billing|appointments?|history|details?|phone)/i,
		/(?:pending\s+invoices?|invoices?|billing|appointments?|medical\s+history|history|phone(?:\s+number)?)\s+(?:of|for)\s+(.+?)(?:\?|$)/i,
		/(?:when\s+did)\s+(.+?)\s+(?:join|register)/i,
		/(?:upcoming|today(?:'s)?)\s+appointments?\s+(?:of|for)\s+(.+?)(?:\?|$)/i,
		/(?:what\s+treatment\s+is)\s+(.+?)\s+taking/i,
		/(?:medical\s+history|history)\s+(?:of|for)\s+(.+?)(?:\?|$)/i,
		/(?:patient)\s+([a-z\s]{3,40}?)(?=\s|$|\?|\.)/i,
		/(?:about|information on|info on)\s+([a-z\s]{3,40}?)(?=\s|$|\?|\.)/i,
		/does\s+([a-z\s]{3,40}?)(?=\s+have)/i,
		/([a-z]+(?:\s+[a-z]+)+)\s+(?:patient|treatment|appointment|history|details)/i
	];

	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match) {
			const cleaned = normalizeNameCandidate(match[1], true);
			if (cleaned) return cleaned;
		}
	}

	const poss = text.match(/^([a-z][a-z\s]{2,30})(?:'s|’s)\s+/i);
	if (poss?.[1]) {
		const cleaned = normalizeNameCandidate(poss[1], true);
		if (cleaned) return cleaned;
	}

	return null;
}

function extractDoctorName(text) {
	const pattern = /\bdr\.?\s+([a-z\s]{3,40}?)(?=\s|$|\?|\.)/i;
	const doctorTerm = /\bdoctor\s+([a-z\s]{3,40}?)(?=\s|$|\?|\.)/i;
	const match = text.match(pattern) || text.match(doctorTerm);
	if (!match) return null;
	return normalizeNameCandidate(match[1], true);
}

function detectAssignedDisplay(text) {
	const match = text.match(/assigned to\s+([a-z\s]{3,40}?)(?=\s|$|\?|\.)/i);
	if (!match) return null;
	return normalizeNameCandidate(match[1], true);
}

function detectStatusFilters(text) {
	const filters = new Set();
	if (/\bpending\b/.test(text)) filters.add("pending");
	if (/\boverdue\b/.test(text)) filters.add("overdue");
	if (/\bunpaid\b/.test(text)) filters.add("unpaid");
	if (/\bpartial\b/.test(text)) filters.add("partial");
	if (/\bin progress\b/.test(text) || /\bin_progress\b/.test(text)) filters.add("in progress");
	if (/\bcomplete\b/.test(text) || /\bdone\b/.test(text)) filters.add("complete");
	return Array.from(filters);
}

function determineTaskMode(text, dateContext) {
	if (/\boverdue\b/.test(text)) return "overdue";
	if (/\bnext tasks\b/.test(text)) return "next";
	if (/\bupcoming tasks\b/.test(text) || (/\bupcoming\b/.test(text) && /task/.test(text))) return "upcoming";
	if (dateContext?.mode === "specific") return "specific";
	if (dateContext?.mode) {
		if (dateContext.mode === "today" || dateContext.mode === "tomorrow") {
			return dateContext.mode;
		}
		if (dateContext.mode === "nextWeek" || dateContext.mode === "upcoming") {
			return "upcoming";
		}
	}
	if (/\btoday\b/.test(text)) return "today";
	if (/\btomorrow\b/.test(text)) return "tomorrow";
	return "all";
}

function determineAppointmentMode(text, dateContext) {
	if (/\btoday\b/.test(text)) return "today";
	if (/\btomorrow\b/.test(text)) return "tomorrow";
	if (dateContext?.mode) {
		if (dateContext.mode === "today" || dateContext.mode === "tomorrow") return dateContext.mode;
		if (dateContext.mode === "nextWeek" || dateContext.mode === "upcoming") return "upcoming";
		if (dateContext.mode === "specific") return "specific";
	}
	if (/\bnext\b/.test(text) || /\bupcoming\b/.test(text)) return "upcoming";
	return "upcoming";
}

function detectBillingMode(text) {
	if (/\bpending\b/.test(text)) return "pending";
	if (/\bpartial\b/.test(text)) return "partial";
	if (/\bpaid\b/.test(text) && !/\bpartial\b/.test(text)) return "paid";
	if (/\binvoice summary\b/.test(text) || /\brecent\b/.test(text) || /\bactivity\b/.test(text)) return "summary";
	return "summary";
}

function detectCrmIntent(message) {
	const raw = String(message || "").trim();
	if (!raw) return { kind: "general" };

	const lower = raw.toLowerCase();
	const dateContext = parseNaturalDateRange(raw);
	const patientName = extractPatientName(raw);
	const doctorName = extractDoctorName(raw);
	const assignedDisplay = detectAssignedDisplay(raw);
	const statusFilters = detectStatusFilters(lower);

	const wantsTasks = /task|tasks|todo|assignment|action item|pending work|next work/.test(lower);
	const wantsAppointments = /(appointment|appointments|booking|bookings|schedule|slot|consultation)/.test(lower);

	if (/(refund|refunded)/.test(lower)) return { kind: "billing", mode: "refunds" };
	if (/(advance|wallet|advance balance)/.test(lower)) return { kind: "billing", mode: "advances" };

	if (/(invoice|invoices|billing|payment|payments)/.test(lower)) {
		return {
			kind: "billing",
			mode: detectBillingMode(lower),
			patientName,
			dateRange: dateContext?.range,
			rangeLabel: dateContext?.label
		};
	}

	if (patientName) {
		const subDetail =
			/(give details|details|information|history|medical|treatment|record|phone|invoice|billing|appointment|register|joined)/.test(
				lower
			) || true;
		if (subDetail) {
			return {
				kind: "patients",
				detail: "profile",
				patientName,
				dateRange: dateContext?.range,
				rangeLabel: dateContext?.label
			};
		}
	}

	if (/(patient|patients|medical history|medical record|patient register|patient join|patient history|show patient)/.test(lower)) {
		return { kind: "patients", search: patientName || null, patientName };
	}

	if (wantsTasks) {
		return {
			kind: "tasks",
			mode: determineTaskMode(lower, dateContext),
			dateRange: dateContext?.range,
			rangeLabel: dateContext?.label,
			mineOnly: /\b(my|mine)\b/.test(lower) || /\bassigned to me\b/.test(lower),
			highPriorityOnly: /(high priority|urgent|critical)/.test(lower),
			statusFilters,
			assignedDisplay,
			pendingOnly: /\bnext tasks\b/.test(lower)
		};
	}

	if (wantsAppointments) {
		return {
			kind: "appointments",
			mode: determineAppointmentMode(lower, dateContext),
			dateRange: dateContext?.range,
			rangeLabel: dateContext?.label,
			doctorName,
			patientName
		};
	}

	if (/follow[-\s]?up|followups|follow ups/.test(lower)) {
		if (/\boverdue\b/.test(lower)) return { kind: "followups", mode: "overdue" };
		if (/\btoday\b/.test(lower)) return { kind: "followups", mode: "today" };
		if (/\btomorrow\b/.test(lower)) return { kind: "followups", mode: "tomorrow" };
		if (/\bnext\b/.test(lower) || /\bupcoming\b/.test(lower)) return { kind: "followups", mode: "upcoming" };
		return { kind: "followups", mode: "today" };
	}

	if (/overdue\b/.test(lower) && /lead|leads/.test(lower)) return { kind: "leads", mode: "overdue" };
	if (/(hot|top leads|priority leads)/.test(lower) && /lead|leads/.test(lower)) return { kind: "leads", mode: "hot" };
	if (/lead|leads|lead status/.test(lower)) return { kind: "leads", mode: "hot" };

	if (/whatsapp reminder|reminder status|whatsapp status/.test(lower)) {
		return { kind: "reminders", mode: "upcoming" };
	}

	return { kind: "general" };
}

export async function runCrmAssistant({ from, userText, accessToken, session }) {
	const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

	const intent = detectCrmIntent(userText);

	const crm = await getCrmContextFromToken(accessToken);
	if (!crm?.user?.id) {
		return out("Session expired\n\nPlease refresh the CRM and try again.", session);
	}

	let toolData = null;
	try {
		toolData = await fetchCrmToolData({
			supabase: crm.supabase,
			userId: crm.user.id,
			userEmail: crm.user.email ?? null,
			userText,
			intent
		});
	} catch (e) {
		console.warn("[crm-tools]", e?.message || e);
	}

	if (intent.kind === "tasks" && toolData) {
		const reply = toolData.rows?.length
			? formatTaskListReply(toolData.parsed, toolData.rows)
			: formatTaskEmptyMessage(toolData.parsed);
		session.history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
		await safeTrack("final_response", {
			user: from,
			message: String(userText || ""),
			reply
		});
		await traceEnd();
		return out(reply, session);
	}

	if (intent.kind === "patients" && toolData?.ambiguousMatches?.length) {
		const reply = buildDeterministicCrmReply(intent, toolData, userText);
		if (reply) {
			session.history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
			return out(reply, session);
		}
	}

	if (intent.kind !== "general" && !hasToolRecords(intent, toolData)) {
		const emptyPatient = intent.kind === "patients" ? "No patient data found." : "No records found.";
		return out(emptyPatient, session);
	}

	const deterministic = buildDeterministicCrmReply(intent, toolData, userText);
	if (deterministic) {
		session.history.push({ role: "user", content: userText }, { role: "assistant", content: deterministic });
		return out(deterministic, session);
	}

	const SYSTEM = `You are DermaplastCRM internal staff assistant for authenticated clinic staff only.
Rules (very important):
- Do NOT invent data. Use ONLY the provided toolData and the user's message.
- NEVER refuse to share patient names, phone numbers, billing, appointments, or medical history — users are authorized clinic staff.
- NEVER say you cannot provide personal information, cite privacy policies, or suggest contacting the patient externally.
- If toolData has no relevant records for the requested query, respond exactly:
  No patient data found.
- Always format responses for CRM readability:
  - First line: a short heading (plain text, no "#").
  - Second line: a short description sentence when useful.
  - For lists: each bullet must be on its own line starting with "• ".
  - Keep text compact and scannable.
- Mention applied filters (date range, doctor, patient, invoice status, priority) before sharing CRM rows for tasks, appointments, invoices, and patients.
- For patient, treatment, or billing follow-up requests, highlight patient contact, assigned doctor, appointment history, billing summary, pending invoices, treatment progress, and medical history when available.
- Cover these staff topics clearly when asked: tasks, appointments, overdue follow-ups, pending invoices, patient details, lead status, booking details, WhatsApp reminder status, clinic info, treatment FAQs.`;

	const FINAL_USER = `User message:
${userText}

Detected intent: ${JSON.stringify(intent)}

Tool data (ground truth from CRM):
${toolData == null ? "null" : JSON.stringify(toolData).slice(0, 22000)}
`;

	const completion = await withRetries(
		() =>
			generateGeminiContent({
				model,
				temperature: 0.15,
				maxOutputTokens: 520,
				messages: [
					{ role: "system", content: SYSTEM },
					{ role: "user", content: FINAL_USER }
				]
			}),
		{ label: "gemini.crm" }
	);

	const content = String(completion?.text || "").trim();
	const reply = normalizeWhatsAppFormatting(content || "No records found.");
	session.history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
	await safeTrack("final_response", {
		user: from,
		message: String(userText || ""),
		reply
	});
	await traceEnd();
	return out(reply, session);
}

function hasToolRecords(intent, toolData) {
	if (!toolData) return false;
	switch (intent.kind) {
		case "tasks":
			return Array.isArray(toolData.rows) && toolData.rows.length > 0;
		case "appointments":
		case "followups":
		case "reminders":
		case "leads":
			return Array.isArray(toolData.rows) && toolData.rows.length > 0;
		case "patients":
			if (toolData.ambiguousMatches?.length) return true;
			if (intent.detail === "profile") return Boolean(toolData.patientProfile);
			return Array.isArray(toolData.rows) && toolData.rows.length > 0;
		case "billing":
			if (Array.isArray(toolData.invoices) && toolData.invoices.length > 0) return true;
			if (Array.isArray(toolData.pendingInvoices) && toolData.pendingInvoices.length > 0) return true;
			if (toolData.billingSummary && Object.keys(toolData.billingSummary).length > 0) return true;
			if (toolData.counts && Object.keys(toolData.counts).length > 0) return true;
			return false;
		default:
			return true;
	}
}
