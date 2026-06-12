import twilio from "twilio";

const { MessagingResponse } = twilio;

export const GENERAL_WELCOME =
	"Hello 👋 Welcome to Dermaplast Clinic.\nI can help you with:\n1. Book an appointment\n2. Check appointment\n3. Ask clinic/treatment questions\n4. Talk to clinic staff\n\nPlease type what you need help with.";

export const BOOKING_WELCOME =
	"Sure, I’ll help you book an appointment. Please share your full name.";

export const BOOKING_STEPS = {
	name: "Please share your full name.",
	phone: "Please share your phone number.",
	treatment:
		"What treatment or concern is this for? Example: Hair treatment, skin consultation, acne, PRP, laser.",
	date: "Which date would you prefer? Example: 2026-06-15",
	time: "Which time slot would you prefer? Example: 10:00 AM"
};

export function promptForStep(step) {
	return BOOKING_STEPS[step] || BOOKING_STEPS.name;
}

export function formatSlotsList(slots) {
	return slots.map((slot) => `• ${slot}`).join("\n");
}

export function formatBookingConfirmation({ name, treatment, date, time }) {
	return `✅ Appointment booked successfully!

Name: ${name}
Treatment: ${treatment}
Date: ${date}
Time: ${time}

Thank you. Our clinic team will contact you if needed.`;
}

export function buildTwiml(body = "") {
	const twiml = new MessagingResponse();
	if (body) {
		twiml.message(body);
	}
	return twiml.toString();
}
