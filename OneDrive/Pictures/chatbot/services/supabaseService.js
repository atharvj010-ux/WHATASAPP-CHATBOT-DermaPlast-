import { supabase } from "../tasks/supabaseClient.js";

const AVAILABLE_SLOTS_CACHE = [
	"10:00 AM",
	"11:00 AM",
	"12:00 PM",
	"01:00 PM",
	"04:00 PM",
	"05:00 PM",
	"06:00 PM"
];

function logSupabase(action, detail = {}) {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "supabase",
			action,
			...detail
		})
	);
}

export async function findPatientByPhone(phone) {
	const normalized = String(phone || "").trim();
	if (!normalized) return null;
	const { data, error } = await supabase
		.from("patients")
		.select("id,name,phone")
		.eq("phone", normalized)
		.limit(1)
		.maybeSingle();
	if (error) {
		logSupabase("findPatient_error", { error: error.message, phone: normalized });
		throw error;
	}
	logSupabase("findPatient", { phone: normalized, found: Boolean(data) });
	return data || null;
}

export async function createPatient({ name, phone }) {
	const normalized = String(phone || "").trim();
	const { data, error } = await supabase
		.from("patients")
		.insert({ name: String(name || "").trim(), phone: normalized })
		.select("id,name,phone")
		.single();
	if (error) {
		logSupabase("createPatient_error", { error: error.message, phone: normalized });
		throw error;
	}
	logSupabase("createPatient", { patientId: data.id, phone: normalized });
	return data;
}

export async function createAppointment({
	patientId,
	name,
	phone,
	treatment,
	appointmentDate,
	appointmentTime
}) {
	const { data, error } = await supabase
		.from("appointments")
		.insert({
			patient_id: patientId,
			name: String(name || "").trim(),
			phone: String(phone || "").trim(),
			treatment: String(treatment || "").trim(),
			appointment_date: appointmentDate,
			appointment_time: appointmentTime
		})
		.select()
		.single();
	if (error) {
		logSupabase("createAppointment_error", { error: error.message, appointmentDate, appointmentTime });
		throw error;
	}
	logSupabase("createAppointment", { appointmentId: data.id, appointmentDate, appointmentTime });
	return data;
}

export async function getAvailableSlotsByDate(dateIso) {
	const { data, error } = await supabase
		.from("appointments")
		.select("appointment_time")
		.eq("appointment_date", dateIso)
		.eq("status", "booked");
	if (error) {
		logSupabase("getBookedSlots_error", { error: error.message, dateIso });
		throw error;
	}
	const booked = new Set((data || []).map((row) => row.appointment_time));
	logSupabase("getAvailableSlots", { dateIso, count: booked.size });
	return AVAILABLE_SLOTS_CACHE.filter((slot) => !booked.has(slot));
}
