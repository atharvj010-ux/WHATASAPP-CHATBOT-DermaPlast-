import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const SUPABASE_KEY =
	SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
	throw new Error("Missing Supabase credentials (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).");
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
	console.warn(
		"[supabase] SUPABASE_SERVICE_ROLE_KEY is not set — WhatsApp CRM writes may fail RLS. Use the service role key from Supabase dashboard."
	);
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
	auth: { persistSession: false },
	global: { fetch: undefined }
});
