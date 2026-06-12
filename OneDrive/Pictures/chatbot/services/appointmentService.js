import { parseDate } from "chrono-node";
import {
	createAppointment,
	createPatient,
	findPatientByPhone,
	getAvailableSlotsByDate
} from "./supabaseService.js";

const AVAILABLE_SLOTS = [
	"10:00 AM",
	"11:00 AM",
	"12:00 PM",
	"01:00 PM",
	"04:00 PM",
	"05:00 PM",
	"06:00 PM"
];

function logAppointment(action, payload) {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "appointment-service",
			action,
			...payload
		})
	);
}

function formatTime(date) {
	const hh = date.getHours();
	const mm = date.getMinutes();
	const period = hh >= 12 ? "PM" : "AM";
	let hour = hh % 12;
	if (hour === 0) hour = 12;
	return `${String(hour).padStart(2, "0")}:${String(mm).padStart(2, "0")} ${period}`;
}

function normalizeDateInput(input) {
	if (!input) return null;
	const cleaned = String(input).trim().replace(/-/g, "/");
	const parsed = parseDate(cleaned, new Date());
	if (!parsed) return null;
	return parsed.toISOString().split("T")[0];
}

function normalizeTimeInput(input) {
	if (!input) return null;
	const parsed = parseDate(String(input).trim(), new Date());
	if (!parsed) return null;
	const formatted = formatTime(parsed);
	if (!AVAILABLE_SLOTS.includes(formatted)) {
		return null;
	}
	return formatted;
}

async function ensurePatientRecord(name, phone) {
	if (!phone || !name) {
		throw new Error("Both name and phone are required to create a patient record.");
	}

	const normalizedPhone = String(phone).trim();
	const existing = await findPatientByPhone(normalizedPhone);
	if (existing) {
		return existing.id;
	}

	const created = await createPatient({ name, phone: normalizedPhone });
	return created.id;
}

async function isSlotBooked(dateIso, slot) {
	const available = await getAvailableSlotsForDate(dateIso);
	return !available.includes(slot);
}

async function getAvailableSlotsForDate(dateIso) {
	return await getAvailableSlotsByDate(dateIso);
}

async function bookAppointment({
	name,
	phone,
	treatmentType,
	appointmentDate,
	appointmentTime
}) {
	const dateIso = normalizeDateInput(appointmentDate);
	const timeSlot = normalizeTimeInput(appointmentTime);
	if (!dateIso || !timeSlot) {
		throw new Error("Invalid date or time provided.");
	}

	const slotBusy = await isSlotBooked(dateIso, timeSlot);
	if (slotBusy) {
		logAppointment("slot_conflict", { date: dateIso, slot: timeSlot });
		const available = await getAvailableSlotsForDate(dateIso);
		return { ok: false, availableSlots: available };
	}

	const patientId = await ensurePatientRecord(name, phone);
	const appointment = await createAppointment({
		patientId,
		name,
		phone,
		treatment: treatmentType,
		appointmentDate: dateIso,
		appointmentTime: timeSlot
	});

	logAppointment("appointment_booked", {
		appointmentId: appointment.id,
		date: dateIso,
		time: timeSlot,
		patientId
	});
	return { ok: true, appointment, patientId };
}

function formatDateForMessage(isoDate) {
	if (!isoDate) return isoDate;
	const date = new Date(isoDate);
	if (Number.isNaN(date.getTime())) return isoDate;
	const day = String(date.getDate()).padStart(2, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const year = date.getFullYear();
	return `${day}/${month}/${year}`;
}

export {
	AVAILABLE_SLOTS,
	normalizeDateInput,
	normalizeTimeInput,
	getAvailableSlotsForDate,
	bookAppointment,
	isSlotBooked,
	formatDateForMessage
};
