import { createClient } from "@supabase/supabase-js";
import { loadFaq, matchFaqSync } from "./faq.js";
import { isKnowledgeTopicBlocked } from "./crm/receptionistReplies.js";
import { isWithinBusinessHours } from "./bizHours.js";
import { fetchTasksForChatQuery } from "./taskQuery.js";

export { matchFaqSync };

function templateEnvVars(text) {
	if (!text) return text;

	return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
		if (!(key in process.env)) {
			console.warn(`Missing env var for FAQ template: ${key}`);
			return "";
		}
		return process.env[key] ?? "";
	});
}

/**
 * Normalize model output for WhatsApp: spacing, bullets, common split-word glitches.
 */
export function normalizeWhatsAppFormatting(raw) {
	if (!raw || typeof raw !== "string") return "";
	let s = raw.replace(/\r\n/g, "\n").trim();

	const fixes = [
		[/\bPR\s+P\b/gi, "PRP"],
		[/\bP\s*R\s*P\b/gi, "PRP"],
		[/\bmed\s+ication\b/gi, "medication"],
		[/\bMed\s+ication\b/g, "Medication"],
		[/\bapp\s+ointment\b/gi, "appointment"],
		[/\bcon\s+sultation\b/gi, "consultation"]
	];
	for (const [re, rep] of fixes) s = s.replace(re, rep);

	s = s.replace(/[\t\f\v]+/g, " ");
	s = s.replace(/[^\S\n]+/g, " ");
	s = s.replace(/\n{3,}/g, "\n\n");

	const lines = s.split("\n").map((line) => line.trim());
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		if (!line) {
			if (out.length && out[out.length - 1] !== "") out.push("");
			continue;
		}
		const bulletish = /^([\u2022\-*]|\d+\.)\s*/.test(line);
		if (bulletish) {
			line = line.replace(/^([\u2022\-*]|\d+\.)\s*/, "\u2022 ");
			if (out.length && out[out.length - 1] !== "") out.push("");
		}
		out.push(line);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function lookupRestaurantFaq({ question }) {
	if (isKnowledgeTopicBlocked(question)) return null;
	const syncHit = matchFaqSync(question);
	if (syncHit) return templateEnvVars(syncHit);

	const q = question || "";
	const { entries } = loadFaq();

	const hit = entries.find((e) => e._regexes.some((r) => r.test(q)));
	if (!hit) return null;

	return templateEnvVars(hit.answer);
}

async function postCrmWebhook(event, payload) {
	const url = String(process.env.CRM_WEBHOOK_URL || process.env.DERMAPLAST_CRM_WEBHOOK_URL || "").trim();
	const secret = String(process.env.CRM_WEBHOOK_SECRET || "").trim();
	if (!url) return;

	const body = JSON.stringify({
		source: "whatsapp-chatbot",
		event,
		payload,
		at: new Date().toISOString()
	});

	try {
		const headers = { "content-type": "application/json" };
		if (secret) headers["x-crm-webhook-secret"] = secret;

		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 8000);
		const res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
		clearTimeout(t);
		if (!res.ok) {
			console.warn("[crm-webhook]", event, "status", res.status);
		}
	} catch (err) {
		console.warn("[crm-webhook]", event, err?.message || err);
	}
}

export async function createReservationStub({ from, draft }) {
	const reservationId = `APT-${Math.floor(Math.random() * 900000 + 100000)}`;

	const record = {
		reservationId,
		from,
		...draft,
		phone: draft.phone || "(not provided)",
		status: "REQUEST_RECEIVED (demo)"
	};

	void postCrmWebhook("consultation_request", record);

	return record;
}

export async function handoffToHumanStub({ from, summary }) {
	const available = isWithinBusinessHours();
	const handoffId = `HUM-${Math.floor(Math.random() * 90000 + 10000)}`;

	const record = {
		handoffId,
		available,
		from,
		summary
	};

	void postCrmWebhook("handoff_request", record);

	return record;
}

function getSupabaseBase() {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
	if (!url || !anon) return null;
	return { url, anon };
}

export async function getCrmContextFromToken(accessToken) {
	const base = getSupabaseBase();
	if (!base || !accessToken) return null;

	const supabase = createClient(base.url, base.anon, {
		global: {
			headers: {
				Authorization: `Bearer ${accessToken}`
			}
		}
	});

	const { data, error } = await supabase.auth.getUser(accessToken);
	if (error || !data?.user?.id) return null;

	return {
		supabase,
		user: data.user
	};
}

function startOfDay(d = new Date()) {
	const x = new Date(d);
	x.setHours(0, 0, 0, 0);
	return x;
}

function endOfDay(d = new Date()) {
	const x = new Date(d);
	x.setHours(23, 59, 59, 999);
	return x;
}

function toIsoRange(mode) {
	const now = new Date();
	const sod = startOfDay(now);
	const eod = endOfDay(now);
	let from = null;
	let to = null;
	if (mode === "today") {
		from = sod;
		to = eod;
	} else if (mode === "tomorrow") {
		const t = new Date(sod);
		t.setDate(t.getDate() + 1);
		from = t;
		to = endOfDay(t);
	} else if (mode === "overdue") {
		to = sod;
	} else if (mode === "upcoming") {
		from = now;
		const t = new Date(now);
		t.setDate(t.getDate() + 7);
		to = t;
	} else if (mode === "next") {
		from = now;
		const t = new Date(now);
		t.setDate(t.getDate() + 3);
		to = t;
	}
	return {
		from: from ? from.toISOString() : null,
		to: to ? to.toISOString() : null
	};
}

function buildIntentRange(intent) {
	if (intent?.dateRange && (intent.dateRange.from || intent.dateRange.to)) {
		return intent.dateRange;
	}
	return toIsoRange(intent.mode);
}

function isHighPriorityTask(task) {
	const priority = String(task.priority || "").toLowerCase();
	return (
		priority === "p1" ||
		priority.includes("high") ||
		priority.includes("urgent") ||
		priority.includes("critical")
	);
}

async function searchPatientsByName(supabase, ownerId, patientName, limit = 8) {
	if (!patientName) return [];
	const { data, error } = await supabase
		.from("patients")
		.select("id,name,phone,email,gender,age,status,treatment_category,created_at,updated_at")
		.eq("owner_id", ownerId)
		.ilike("name", `%${patientName}%`)
		.order("updated_at", { ascending: false })
		.limit(limit);
	if (error) throw error;
	return data || [];
}

async function resolvePatientRecord(supabase, ownerId, patientName) {
	const matches = await searchPatientsByName(supabase, ownerId, patientName, 8);
	if (!matches.length) return { patient: null, matches: [] };
	const exact = matches.filter((p) => String(p.name || "").toLowerCase() === patientName.toLowerCase());
	if (exact.length === 1) return { patient: exact[0], matches };
	if (matches.length === 1) return { patient: matches[0], matches };
	return { patient: null, matches };
}

export async function fetchCrmToolData({ supabase, userId, userEmail, userText, intent }) {
	const limit = 10;
	if (!intent || intent.kind === "general") return null;

	switch (intent.kind) {
		case "tasks":
			return fetchTasksForChatQuery({
				supabase,
				ownerId: userId,
				userEmail: userEmail ?? null,
				message: userText || ""
			});
		case "appointments":
			return fetchAppointmentData({ supabase, userId, intent, limit });
		case "leads":
			return fetchLeadData({ supabase, userId, intent, limit });
		case "followups":
			return fetchFollowups({ supabase, userId, intent, limit });
		case "billing":
			return fetchBillingData({ supabase, userId, intent, limit });
		case "patients":
			if (intent.detail === "profile" && intent.patientName) {
				return fetchPatientProfile({ supabase, userId, intent, limit: 5 });
			}
			return fetchPatientList({ supabase, userId, intent, limit });
		case "reminders":
			return fetchReminders({ supabase, userId, intent, limit });
		default:
			return null;
	}
}

async function fetchAppointmentData({ supabase, userId, intent, limit }) {
	const range = buildIntentRange(intent);
	let q = supabase
		.from("appointments")
		.select("id,scheduled_at,ends_at,kind,status,doctor_name,patient_name,patient_id,location,whatsapp_message_status,reminder_status")
		.eq("owner_id", userId)
		.limit(200);
	if (range.from) q = q.gte("scheduled_at", range.from);
	if (range.to) q = q.lte("scheduled_at", range.to);
	if (intent.patientName) q = q.ilike("patient_name", `%${intent.patientName}%`);
	if (intent.doctorName) q = q.ilike("doctor_name", `%${intent.doctorName}%`);
	const { data, error } = await q.order("scheduled_at", { ascending: true });
	if (error) throw error;
	const rows = (data || []).slice(0, limit);
	return {
		rows,
		total: (data || []).length,
		filters: {
			dateRange: range,
			rangeLabel: intent.rangeLabel,
			doctorName: intent.doctorName,
			patientName: intent.patientName
		}
	};
}

async function fetchLeadData({ supabase, userId, intent, limit }) {
	let q = supabase
		.from("contacts")
		.select("id,name,phone,lead_stage,lead_temp,follow_up_at,interest")
		.eq("owner_id", userId)
		.eq("type", "lead")
		.limit(200);
	if (intent.mode === "overdue") q = q.lt("follow_up_at", new Date().toISOString());
	if (intent.mode === "hot") q = q.eq("lead_temp", "hot");
	const { data, error } = await q.order("updated_at", { ascending: false });
	if (error) throw error;
	return { rows: (data || []).slice(0, limit), total: (data || []).length };
}

async function fetchFollowups({ supabase, userId, intent, limit }) {
	const range = buildIntentRange(intent);
	let q = supabase
		.from("contact_followups")
		.select("id,contact_id,scheduled_at,scheduled_for,priority,status,note,ref_no,completed_at")
		.eq("owner_id", userId)
		.eq("status", "pending")
		.limit(200);
	if (range.from) q = q.gte("scheduled_at", range.from);
	if (range.to) q = q.lte("scheduled_at", range.to);
	const { data, error } = await q.order("scheduled_at", { ascending: true });
	if (error) throw error;
	const rows = (data || []).slice(0, limit);
	return { rows, total: (data || []).length };
}

async function fetchBillingData({ supabase, userId, intent, limit }) {
	if (intent.mode === "refunds") {
		const { data: refundsAll, error: rErr } = await supabase
			.from("billing_refunds")
			.select("id,refund_id,bill_date,patient_display_id,patient_name,amount_inr,balance_remaining")
			.eq("owner_id", userId)
			.order("bill_date", { ascending: false })
			.limit(200);
		if (rErr) throw rErr;
		return { refunds: (refundsAll || []).slice(0, limit), counts: { total_refunds: (refundsAll || []).length } };
	}

	if (intent.mode === "advances") {
		const { data: advAll, error: aErr } = await supabase
			.from("billing_advances")
			.select("id,patient_display_id,patient_name,balance_remaining,bill_date,advance_id")
			.eq("owner_id", userId)
			.order("bill_date", { ascending: false })
			.limit(200);
		if (aErr) throw aErr;
		const advances = advAll || [];
		const sum = advances.reduce((acc, a) => acc + Number(a.balance_remaining || 0), 0);
		return { advanceBalance: sum, counts: { total_advances_rows: advances.length } };
	}

	const { patient } = await resolvePatientRecord(supabase, userId, intent.patientName);
	let q = supabase
		.from("billing_invoices")
		.select("id,invoice_number,issued_on,patient_name,amount_inr,paid_inr,payment_status,description")
		.eq("owner_id", userId)
		.order("issued_on", { ascending: false })
		.limit(200);
	if (patient?.id) q = q.eq("patient_id", patient.id);
	const { data: invoicesAll, error: invErr } = await q;
	if (invErr) throw invErr;
	const invoices = invoicesAll || [];
	const pending = invoices.filter((i) => {
		const ps = String(i.payment_status || "").toLowerCase();
		return ps === "pending" || ps === "partial";
	});
	const paid = invoices.filter((i) => (String(i.payment_status || "").toLowerCase() || "").includes("paid"));
	const partial = invoices.filter((i) => (String(i.payment_status || "").toLowerCase() || "").includes("partial"));
	let rows = invoices.slice(0, limit);
	if (intent.mode === "pending") {
		rows = pending.slice(0, limit);
	} else if (intent.mode === "paid") {
		rows = paid.slice(0, limit);
	} else if (intent.mode === "partial") {
		rows = partial.slice(0, limit);
	}
	const counts = {
		total_invoices: invoices.length,
		pending_invoices: pending.length,
		paid_invoices: paid.length,
		partial_invoices: partial.length
	};
	const totalAmount = invoices.reduce((acc, inv) => acc + Number(inv.amount_inr || 0), 0);
	const totalPaid = invoices.reduce((acc, inv) => acc + Number(inv.paid_inr || 0), 0);
	const billingSummary = {
		totalAmount,
		totalPaid,
		pendingBalance: Math.max(0, totalAmount - totalPaid)
	};
	return {
		rows,
		counts,
		billingSummary,
		pendingInvoices: pending.slice(0, limit),
		recentInvoices: invoices.slice(0, limit),
		patient: patient ? { id: patient.id, name: patient.name } : null,
		filters: {
			mode: intent.mode,
			patientName: intent.patientName
		}
	};
}

async function fetchPatientList({ supabase, userId, intent, limit }) {
	let q = supabase
		.from("patients")
		.select("id,name,phone,gender,age,treatment_category,status,created_at,updated_at")
		.eq("owner_id", userId)
		.limit(200);
	if (intent.search) q = q.ilike("name", `%${intent.search}%`);
	const { data, error } = await q.order("updated_at", { ascending: false });
	if (error) throw error;
	return {
		rows: (data || []).slice(0, limit),
		total: (data || []).length,
		filters: {
			search: intent.search
		}
	};
}

async function fetchPatientProfile({ supabase, userId, intent, limit }) {
	const { patient, matches } = await resolvePatientRecord(supabase, userId, intent.patientName);
	if (!patient) {
		if (matches.length > 1) {
			return { ambiguousMatches: matches };
		}
		return null;
	}
	const detailLimit = limit ?? 5;
	const nowIso = new Date().toISOString();
	const [appointmentsRes, upcomingRes, treatmentsRes, invoicesRes, activitiesRes, docRes, taskRes] = await Promise.all([
		supabase
			.from("appointments")
			.select("scheduled_at,ends_at,kind,status,doctor_name,location,notes")
			.eq("owner_id", userId)
			.eq("patient_id", patient.id)
			.order("scheduled_at", { ascending: false })
			.limit(detailLimit),
		supabase
			.from("appointments")
			.select("scheduled_at,doctor_name")
			.eq("owner_id", userId)
			.eq("patient_id", patient.id)
			.gte("scheduled_at", nowIso)
			.eq("status", "scheduled")
			.order("scheduled_at", { ascending: true })
			.limit(1),
		supabase
			.from("treatments")
			.select("name,status,progress_pct,summary,started_at,completed_at")
			.eq("owner_id", userId)
			.eq("patient_id", patient.id)
			.order("updated_at", { ascending: false })
			.limit(detailLimit),
		supabase
			.from("billing_invoices")
			.select("invoice_number,issued_on,amount_inr,paid_inr,payment_status,description")
			.eq("owner_id", userId)
			.eq("patient_id", patient.id)
			.order("issued_on", { ascending: false })
			.limit(200),
		supabase
			.from("activities")
			.select("occurred_at,type,title,description,meta")
			.eq("owner_id", userId)
			.eq("patient_id", patient.id)
			.order("occurred_at", { ascending: false })
			.limit(detailLimit),
		supabase
			.from("patient_documents")
			.select("id", { count: "exact", head: true })
			.eq("owner_id", userId)
			.eq("patient_id", patient.id),
		supabase
			.from("tasks")
			.select("title,status,due_date")
			.eq("owner_id", userId)
			.eq("linked_entity_type", "patient")
			.eq("linked_entity_id", patient.id)
			.neq("status", "complete")
			.order("due_date", { ascending: true })
			.limit(5)
	]);
	const appointments = appointmentsRes.data || [];
	const treatments = treatmentsRes.data || [];
	const invoices = invoicesRes.data || [];
	const activities = activitiesRes.data || [];
	const appointmentHistory = appointments.map((a) => ({
		scheduled_at: a.scheduled_at,
		status: a.status,
		kind: a.kind,
		doctor_name: a.doctor_name,
		location: a.location,
		notes: a.notes
	}));
	const treatmentHistory = treatments.map((t) => ({
		name: t.name,
		status: t.status,
		progress: t.progress_pct,
		summary: t.summary,
		started_at: t.started_at,
		completed_at: t.completed_at
	}));
	const patientInvoices = invoices.slice(0, detailLimit);
	const pendingInvoices = invoices
		.filter((i) => {
			const status = String(i.payment_status || "").toLowerCase();
			return status === "pending" || status === "partial";
		})
		.slice(0, detailLimit);
	const totalAmount = invoices.reduce((acc, inv) => acc + Number(inv.amount_inr || 0), 0);
	const totalPaid = invoices.reduce((acc, inv) => acc + Number(inv.paid_inr || 0), 0);
	const billingSummary = {
		totalAmount,
		totalPaid,
		pendingBalance: Math.max(0, totalAmount - totalPaid)
	};
	const lastVisit =
		(appointmentHistory.find((a) => a.status === "completed") || appointmentHistory[0])?.scheduled_at || null;
	const upcomingRow = (upcomingRes.data || [])[0];
	return {
		upcomingAppointment: upcomingRow
			? { scheduled_at: upcomingRow.scheduled_at, doctor_name: upcomingRow.doctor_name }
			: null,
		documentCount: docRes.count ?? 0,
		linkedTasks: taskRes.data || [],
		patientProfile: {
			id: patient.id,
			name: patient.name,
			phone: patient.phone,
			email: patient.email,
			gender: patient.gender,
			age: patient.age,
			status: patient.status,
			treatmentCategory: patient.treatment_category,
			registrationDate: patient.created_at,
			doctorAssigned: appointmentHistory[0]?.doctor_name || null,
			lastVisit
		},
		appointmentHistory,
		treatmentHistory,
		invoices: patientInvoices,
		pendingInvoices,
		billingSummary,
		medicalHistory: activities,
		filters: {
			patientName: patient.name
		}
	};
}

async function fetchReminders({ supabase, userId, intent, limit }) {
	const range = buildIntentRange({ dateRange: intent.dateRange, mode: intent.mode || "upcoming" });
	let q = supabase
		.from("appointments")
		.select("id,scheduled_at,patient_name,doctor_name,whatsapp_message_status,reminder_status")
		.eq("owner_id", userId)
		.limit(200);
	if (range.from) q = q.gte("scheduled_at", range.from);
	if (range.to) q = q.lte("scheduled_at", range.to);
	const { data, error } = await q.order("scheduled_at", { ascending: true });
	if (error) throw error;
	return {
		rows: (data || []).slice(0, limit),
		total: (data || []).length,
		filters: { dateRange: range, rangeLabel: intent.rangeLabel }
	};
}
