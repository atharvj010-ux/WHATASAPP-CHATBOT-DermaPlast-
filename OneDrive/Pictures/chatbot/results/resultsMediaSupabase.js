import fs from "node:fs";
import { supabase } from "../tasks/supabaseClient.js";
import { STATIC_RESULT_IMAGES } from "./staticResults.js";
import { getLocalResultFilePath } from "./resultsMedia.js";

const BUCKET = "patient-documents";
const STORAGE_PREFIX = "whatsapp-static-results";

/**
 * Upload local result JPEGs to public Supabase storage (Twilio-friendly HTTPS).
 * @returns {Promise<Array<{ file: string, url: string }>>}
 */
export async function resolveSupabaseResultMediaUrls() {
	const out = [];

	for (const file of STATIC_RESULT_IMAGES) {
		const localPath = getLocalResultFilePath(file);
		if (!localPath) {
			console.warn("[resultsMediaSupabase] missing local file", file);
			continue;
		}

		const storagePath = `${STORAGE_PREFIX}/${file}`;
		const buffer = fs.readFileSync(localPath);

		const { error } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
			contentType: "image/jpeg",
			upsert: true,
			cacheControl: "31536000"
		});

		if (error) {
			console.error("[resultsMediaSupabase] upload failed", storagePath, error.message);
			throw error;
		}

		const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
		if (!data?.publicUrl) {
			throw new Error(`No public URL for ${storagePath}`);
		}

		out.push({ file, url: data.publicUrl });
	}

	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "results-handler",
			event: "supabase_media_urls",
			count: out.length,
			urls: out.map((o) => o.url)
		})
	);

	return out;
}
