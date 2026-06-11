const MAX_PROCESSED_IDS = 5000;
const processedOrder = [];
const processedMessageSids = new Set();
const sessionState = new Map();

/**
 * Session schema per WhatsApp user:
 * {
 *   history: model chat messages (rolling window),
 *   flow: null | "RESERVATION" | "APPOINTMENT_BOOKING",
 *   reservationDraft: {
 *     name?, treatment?, date? (YYYY-MM-DD), time? (HH:mm), phone?, notes?
 *   },
 *   appointmentDraft: {
 *     patientName?, patientId?, dateIso?, timeHHmm?, kind?, clinician?, location?,
 *     treatmentLabel?, awaiting?: "slot_choice", suggestedSlots?: string[]
 *   },
 *   resultsLastSentAt?: number,
 *   resultsLastCategory?: string,
 *   preferredLanguage?: "en" | "hi" | "mr"
 * }
 */

function rememberProcessed(messageSid) {
	processedMessageSids.add(messageSid);
	processedOrder.push(messageSid);
	while (processedOrder.length > MAX_PROCESSED_IDS) {
		const old = processedOrder.shift();
		processedMessageSids.delete(old);
	}
}

export function hasProcessed(messageSid) {
	return processedMessageSids.has(messageSid);
}

export function markProcessed(messageSid) {
	rememberProcessed(messageSid);
}

export function getSession(userId) {
	return (
		sessionState.get(userId) ?? {
			history: [],
			flow: null,
			reservationDraft: {},
			appointmentDraft: {}
		}
	);
}

export function setSession(userId, session) {
	sessionState.set(userId, session);
}
