import { supabase } from "../tasks/supabaseClient.js";

function ownerId() {
	return String(process.env.SUPABASE_DEFAULT_OWNER_ID || "").trim() || null;
}

function externalKey(phone) {
	return `wa:${String(phone || "").replace(/\D/g, "")}`;
}

export async function loadPersistedSession(phone) {
	const oid = ownerId();
	if (!oid || !phone) return null;

	const { data, error } = await supabase
		.from("chat_sessions")
		.select("id, session_meta, preferred_language")
		.eq("owner_id", oid)
		.eq("external_key", externalKey(phone))
		.eq("channel", "whatsapp")
		.maybeSingle();

	if (error || !data?.session_meta) return null;
	const meta = data.session_meta;
	return {
		sessionId: data.id,
		session: {
			history: Array.isArray(meta.history) ? meta.history : [],
			flow: meta.flow ?? null,
			reservationDraft: meta.reservationDraft ?? {},
			appointmentDraft: meta.appointmentDraft ?? {},
			resultsLastSentAt: meta.resultsLastSentAt,
			resultsLastCategory: meta.resultsLastCategory,
			preferredLanguage: data.preferred_language ?? meta.preferredLanguage ?? "en"
		}
	};
}

export async function persistSession(phone, session, opts = {}) {
	const oid = ownerId();
	if (!oid || !phone) return null;

	const key = externalKey(phone);
	const sessionMeta = {
		history: session.history ?? [],
		flow: session.flow ?? null,
		reservationDraft: session.reservationDraft ?? {},
		appointmentDraft: session.appointmentDraft ?? {},
		resultsLastSentAt: session.resultsLastSentAt,
		resultsLastCategory: session.resultsLastCategory,
		preferredLanguage: session.preferredLanguage ?? "en"
	};

	const row = {
		owner_id: oid,
		external_key: key,
		channel: "whatsapp",
		user_phone: phone,
		user_role: opts.userRole ?? "patient",
		preferred_language: session.preferredLanguage ?? "en",
		title: `WhatsApp ${phone.slice(-4)}`,
		session_meta: sessionMeta,
		updated_at: new Date().toISOString()
	};

	const { data: existing } = await supabase
		.from("chat_sessions")
		.select("id")
		.eq("owner_id", oid)
		.eq("external_key", key)
		.maybeSingle();

	if (existing?.id) {
		const { data } = await supabase.from("chat_sessions").update(row).eq("id", existing.id).select("id").single();
		return data?.id ?? existing.id;
	}

	const { data } = await supabase.from("chat_sessions").insert(row).select("id").single();
	return data?.id ?? null;
}

export async function insertChatMessage(sessionId, role, content, meta = {}) {
	const oid = ownerId();
	if (!oid || !sessionId) return;
	await supabase.from("chat_messages").insert({
		owner_id: oid,
		session_id: sessionId,
		role,
		content,
		meta
	});
}
