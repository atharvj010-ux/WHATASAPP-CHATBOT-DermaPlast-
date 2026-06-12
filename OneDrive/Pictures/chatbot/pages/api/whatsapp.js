import { handleInboundWhatsApp } from "../../inbound.js";

export default async function handler(req, res) {
	if (req.method !== "POST") {
		res.status(405).type("text/plain").send("Method not allowed");
		return;
	}

	try {
		const result = await handleInboundWhatsApp({
			body: req.body || {},
			req
		});

		res.status(result.status).type(result.contentType).send(result.body);
		if (result.queued && result.runAsyncWork) {
			void result.runAsyncWork();
		}
	} catch (_err) {
		res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
	}
}

