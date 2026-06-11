function formatInr(amount) {
	return `₹${Math.round(Number(amount) || 0).toLocaleString("en-IN")}`;
}

export function formatDateShort(iso) {
	if (!iso) return "N/A";
	const d = new Date(iso);
	if (!Number.isFinite(d.getTime())) return "N/A";
	return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTimeShort(iso) {
	if (!iso) return "N/A";
	const d = new Date(iso);
	if (!Number.isFinite(d.getTime())) return "N/A";
	const date = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
	const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
	return `${date} – ${time}`;
}

function formatTreatmentLabel(category) {
	if (!category) return "N/A";
	return String(category).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function invoicePendingAmount(inv) {
	const amount = Number(inv.amount_inr ?? 0);
	const paid = Number(inv.paid_inr ?? 0);
	const status = String(inv.payment_status ?? "").toLowerCase();
	if (status === "paid") return 0;
	return Math.max(0, amount - paid);
}

export function formatPatientSuggestions(matches) {
	const lines = ["Multiple patients found", "Please specify which patient:"];
	matches.slice(0, 6).forEach((p, i) => {
		const phone = p.phone ? ` • ${p.phone}` : "";
		lines.push(`• ${i + 1}. ${p.name}${phone}`);
	});
	return lines.join("\n");
}

export function formatPatientProfileReply(toolData, subIntent = "profile") {
	if (toolData?.ambiguousMatches?.length) {
		return formatPatientSuggestions(toolData.ambiguousMatches);
	}

	const p = toolData?.patientProfile;
	if (!p) return "No patient data found.";

	const lines = [p.name, ""];

	if (subIntent === "phone") {
		lines.push(`• Phone: ${p.phone || "N/A"}`);
		return lines.join("\n");
	}

	if (subIntent === "registration") {
		lines.push(`• Registration Date: ${formatDateShort(p.registrationDate)}`);
		return lines.join("\n");
	}

	if (subIntent === "billing") {
		const pending = toolData.billingSummary?.pendingBalance ?? 0;
		lines.push(`• Pending Invoice: ${pending > 0 ? formatInr(pending) : "None"}`);
		const list = toolData.pendingInvoices?.length ? toolData.pendingInvoices : toolData.invoices;
		if (list?.length) {
			lines.push("");
			lines.push("Recent invoices:");
			list.slice(0, 5).forEach((inv) => {
				lines.push(
					`• ${inv.invoice_number} (${formatDateShort(inv.issued_on)}) – ${formatInr(inv.amount_inr)} – ${inv.payment_status || "pending"}`
				);
			});
		}
		return lines.join("\n");
	}

	if (subIntent === "appointments") {
		if (toolData.upcomingAppointment) {
			lines.push(
				`• Upcoming Appointment: ${formatDateTimeShort(toolData.upcomingAppointment.scheduled_at)} – ${toolData.upcomingAppointment.doctor_name || "N/A"}`
			);
		} else {
			lines.push("• Upcoming Appointment: None scheduled");
		}
		if (toolData.appointmentHistory?.length) {
			lines.push("");
			lines.push("Recent visits:");
			toolData.appointmentHistory.slice(0, 5).forEach((a) => {
				lines.push(
					`• ${formatDateTimeShort(a.scheduled_at)} – ${a.kind || "visit"} – ${a.status || "N/A"} – ${a.doctor_name || "N/A"}`
				);
			});
		}
		return lines.join("\n");
	}

	if (subIntent === "treatment") {
		const active = toolData.treatmentHistory?.[0];
		lines.push(
			`• Treatment: ${active ? `${active.name} (${active.status || "N/A"}, ${active.progress ?? 0}%)` : formatTreatmentLabel(p.treatmentCategory)}`
		);
		return lines.join("\n");
	}

	if (subIntent === "history") {
		if (!toolData.medicalHistory?.length) {
			lines.push("No medical history records found.");
			return lines.join("\n");
		}
		toolData.medicalHistory.slice(0, 8).forEach((a) => {
			lines.push(`• ${formatDateShort(a.occurred_at)} – ${a.type}: ${a.title}`);
		});
		return lines.join("\n");
	}

	const lastVisit = p.lastVisit ? formatDateShort(p.lastVisit) : "N/A";
	const doctor = p.doctorAssigned || "N/A";
	const doctorLabel = doctor === "N/A" ? doctor : doctor.startsWith("Dr") ? doctor : `Dr. ${doctor}`;
	const treatment =
		toolData.treatmentHistory?.[0]?.name || formatTreatmentLabel(p.treatmentCategory);
	const pending = toolData.billingSummary?.pendingBalance ?? 0;

	lines.push(`• Phone: ${p.phone || "N/A"}`);
	if (p.age != null) lines.push(`• Age: ${p.age}`);
	if (p.gender) lines.push(`• Gender: ${String(p.gender).charAt(0).toUpperCase() + String(p.gender).slice(1)}`);
	lines.push(`• Registration Date: ${formatDateShort(p.registrationDate)}`);
	lines.push(`• Last Visit: ${lastVisit}`);
	lines.push(`• Pending Invoice: ${pending > 0 ? formatInr(pending) : "None"}`);
	lines.push(`• Treatment: ${treatment}`);
	lines.push(`• Doctor: ${doctorLabel}`);
	if (toolData.upcomingAppointment) {
		lines.push(
			`• Upcoming Appointment: ${formatDateTimeShort(toolData.upcomingAppointment.scheduled_at)} – ${toolData.upcomingAppointment.doctor_name || "N/A"}`
		);
	}
	if (toolData.documentCount > 0) {
		lines.push(`• Documents on file: ${toolData.documentCount}`);
	}

	return lines.join("\n");
}

export function detectPatientSubIntent(message) {
	const t = String(message || "").toLowerCase();
	if (/\b(phone|mobile|contact\s+number)\b/.test(t)) return "phone";
	if (/\b(when\s+did|register|joined|join\s+the\s+clinic)\b/.test(t)) return "registration";
	if (/\b(pending\s+invoice|invoices?|billing|payment)\b/.test(t)) return "billing";
	if (/\b(appointment|appointments|schedule|visit)\b/.test(t)) return "appointments";
	if (/\b(medical\s+history|history|activities)\b/.test(t)) return "history";
	if (/\b(treatment|therapy|procedure)\b/.test(t)) return "treatment";
	return "profile";
}

export function buildDeterministicCrmReply(intent, toolData, userText) {
	if (!toolData) return null;

	if (intent.kind === "patients") {
		const sub = detectPatientSubIntent(userText);
		if (toolData.ambiguousMatches?.length) return formatPatientSuggestions(toolData.ambiguousMatches);
		if (toolData.patientProfile) return formatPatientProfileReply(toolData, sub);
		if (toolData.rows?.length) {
			return formatPatientSuggestions(toolData.rows);
		}
		return "No patient data found.";
	}

	if (intent.kind === "tasks" && toolData.parsed) {
		return null;
	}

	if (intent.kind === "billing" && intent.patientName && toolData.patient) {
		return formatPatientProfileReply(
			{
				patientProfile: {
					name: toolData.patient.name,
					phone: null,
					age: null,
					gender: null,
					registrationDate: null,
					treatmentCategory: null,
					doctorAssigned: null,
					lastVisit: null
				},
				billingSummary: toolData.billingSummary,
				pendingInvoices: toolData.pendingInvoices,
				invoices: toolData.rows
			},
			"billing"
		);
	}

	return null;
}
