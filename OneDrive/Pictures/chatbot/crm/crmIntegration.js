import { supabase } from "../tasks/supabaseClient.js";
import { getClinicTimezone } from "../clinicTimezone.js";
import { LANG } from "./language.js";
import { buildFullClinicInfoReply } from "./i18nMessages.js";
import { getClinicFacts } from "./clinicInfo.js";
import {
	isGreetingMessage,
	isPricingMessage,
	isGenericTreatmentInquiry
} from "./receptionistReplies.js";
import { isTreatmentEducationQuery } from "./treatmentEducation.js";

export const CRM_ERRORS = {
	PATIENT_NOT_FOUND:
		"Patient not found in CRM. Please provide the correct patient name or phone number.",
	MISSING_APPOINTMENT_DATETIME: "Please provide appointment date and time.",
	MISSING_TASK_DATETIME: "Please provide task due date and time.",
	CREATE_FAILED: "Unable to create the record at the moment. Please try again later.",
	APPOINTMENT_CREATE_FAILED: "Unable to create the appointment. Please try again.",
	TASK_CREATE_FAILED: "Unable to create the task. Please try again."
};

export function getCrmAppUrl() {
	return (
		String(process.env.DERMAPLAST_CRM_URL || "").trim() ||
		String(process.env.CRM_APP_URL || "").trim() ||
		"https://dermaplastcrm.vercel.app"
	).replace(/\/+$/, "");
}

export function logCrm(event, data = {}) {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "crm-integration",
			crmUrl: getCrmAppUrl(),
			event,
			...data
		})
	);
}

function clinicBranding() {
	return getClinicFacts();
}

export { buildGreetingReply as buildWelcomeMessage } from "./receptionistReplies.js";

/** Full clinic details — never phone-only. */
export function buildClinicTimingsReply(lang = LANG.EN) {
	const l = lang === LANG.MR || lang === LANG.HI ? lang : LANG.EN;
	const name = clinicBranding().name;
	const intros = {
		[LANG.EN]: `${name} — clinic timings and contact:`,
		[LANG.HI]: `${name} — क्लिनिक का समय और संपर्क:`,
		[LANG.MR]: `${name} — क्लिनिकची वेळ आणि संपर्क:`
	};
	return buildFullClinicInfoReply(l, { introLine: intros[l] });
}

export function buildClinicContactReply(lang = LANG.EN) {
	const l = lang === LANG.MR || lang === LANG.HI ? lang : LANG.EN;
	const name = clinicBranding().name;
	const intros = {
		[LANG.EN]: `${name} — clinic information:`,
		[LANG.HI]: `${name} — क्लिनिक की जानकारी:`,
		[LANG.MR]: `${name} — क्लिनिकची माहिती:`
	};
	return buildFullClinicInfoReply(l, { introLine: intros[l] });
}

export {
	buildReceptionistGeneralReply as buildGeneralFallbackReply,
	buildAppointmentGuidanceReply as buildAppointmentBookingGuidance,
	buildTreatmentInterestReply,
	buildPricingReply,
	buildFollowUpTaskGuidanceReply
} from "./receptionistReplies.js";

export function formatAppointmentSuccessMessage(patientName, scheduledAtIso) {
	const tz = getClinicTimezone();
	const d = new Date(scheduledAtIso);
	const datePart = d.toLocaleDateString("en-IN", {
		timeZone: tz,
		day: "numeric",
		month: "long",
		year: "numeric"
	});
	const timePart = d.toLocaleTimeString("en-IN", {
		timeZone: tz,
		hour: "numeric",
		minute: "2-digit",
		hour12: true
	});
	const clinic = clinicBranding().name;
	return `Appointment booked successfully for ${patientName} on ${datePart} at ${timePart} with ${clinic}.`;
}

export function formatTaskSuccessMessage(patientName, dueDateIso, taskTitle = "Follow-up") {
	const tz = getClinicTimezone();
	const d = new Date(dueDateIso);
	const datePart = d.toLocaleDateString("en-IN", {
		timeZone: tz,
		day: "numeric",
		month: "long",
		year: "numeric"
	});
	const timePart = d.toLocaleTimeString("en-IN", {
		timeZone: tz,
		hour: "numeric",
		minute: "2-digit",
		hour12: true
	});
	const isFollowUp = /\bfollow[\s-]?up\b/i.test(taskTitle);
	if (isFollowUp) {
		return `Follow-up task created successfully for ${patientName} on ${datePart} at ${timePart}.`;
	}
	return `Task created successfully for ${patientName} on ${datePart} at ${timePart}.`;
}

/**
 * Find patient (preferred) or lead by name in live Supabase CRM.
 * @returns {Promise<{ kind: 'patient', patient: object } | { kind: 'lead', lead: object, patient: object | null } | null>}
 */
export async function findPatientOrLeadByName(name) {
	const fragment = String(name || "").trim();
	if (!fragment) return null;

	logCrm("lookup_start", { name: fragment });

	const { data: patients, error: pErr } = await supabase
		.from("patients")
		.select("id,name,owner_id,phone")
		.ilike("name", `%${fragment}%`)
		.limit(8);

	if (pErr) {
		logCrm("patient_lookup_error", { error: pErr.message });
	} else if (patients?.length) {
		const exact = patients.find((p) => p.name?.toLowerCase() === fragment.toLowerCase());
		const patient = exact ?? patients[0];
		logCrm("patient_found", { patientId: patient.id, name: patient.name });
		return { kind: "patient", patient };
	}

	const { data: leads, error: lErr } = await supabase
		.from("leads")
		.select("id,name,owner_id,patient_id")
		.ilike("name", `%${fragment}%`)
		.limit(8);

	if (lErr) {
		logCrm("lead_lookup_error", { error: lErr.message });
		return null;
	}

	if (!leads?.length) {
		logCrm("lookup_not_found", { name: fragment });
		return null;
	}

	const exactLead = leads.find((l) => l.name?.toLowerCase() === fragment.toLowerCase());
	const lead = exactLead ?? leads[0];
	logCrm("lead_found", { leadId: lead.id, name: lead.name, patientId: lead.patient_id });

	if (lead.patient_id) {
		const { data: patient } = await supabase
			.from("patients")
			.select("id,name,owner_id,phone")
			.eq("id", lead.patient_id)
			.maybeSingle();
		if (patient) {
			return { kind: "patient", patient, lead };
		}
	}

	return { kind: "lead", lead, patient: null };
}

/** Resolve patient row for appointments/tasks from CRM lookup result. */
export function resolvePatientRecord(lookup) {
	if (!lookup) return null;
	if (lookup.kind === "patient") return lookup.patient;
	if (lookup.patient) return lookup.patient;
	return null;
}

export function isExplicitCrmAppointmentCommand(text) {
	const t = String(text || "");
	return (
		/\b(book|schedule|create)\b/i.test(t) &&
		/\bappointment\b/i.test(t) &&
		/\bfor\b/i.test(t)
	);
}

export function isExplicitCrmTaskCommand(text) {
	const t = String(text || "").toLowerCase();
	return (
		(/\b(create|add|schedule)\b/.test(t) && (/\btask\b/.test(t) || /\bfollow[\s-]?up\b/.test(t))) ||
		/\bcreate\b.*\bfollow[\s-]?up\b/.test(t)
	);
}

export function classifyInboundIntent(text) {
	const t = String(text || "").toLowerCase().trim();
	if (!t) return "empty";

	if (isExplicitCrmAppointmentCommand(text)) return "crm_appointment";
	if (isExplicitCrmTaskCommand(text)) return "crm_task";

	if (isGreetingMessage(text)) {
		return "greeting";
	}

	if (
		/\b(timing|timings|hours|working hours|open today|when.*open|what time.*open)\b/.test(t) ||
		/(वेळ|समय|खुला|बंद|टाइमिंग|किती वाजता)/i.test(text)
	) {
		return "clinic_timings";
	}
	if (
		/\b(address|location|where are you|contact|phone number)\b/.test(t) ||
		/(पत्ता|पता|संपर्क|क्लिनिक कुठे|कहाँ है|कुठे आहे)/i.test(text)
	) {
		return "clinic_contact";
	}
	if (/\b(book|schedule|appointment|how can i book)\b/.test(t)) return "appointment_info";
	if (isPricingMessage(text)) return "pricing";
	if (isTreatmentEducationQuery(text)) return "treatment_education";
	if (isGenericTreatmentInquiry(text)) return "treatment";
	return "general";
}
