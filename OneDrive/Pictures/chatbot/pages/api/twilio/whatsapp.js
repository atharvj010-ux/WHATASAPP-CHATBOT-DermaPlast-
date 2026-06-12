import { handleInboundWhatsApp } from "../../../inbound.js";

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

		// Vercel is serverless: await queued async work so Twilio messages
		// are actually sent before the function terminates.
		if (result?.queued && typeof result.runAsyncWork === "function") {
			await result.runAsyncWork();
		}

		// Twilio expects TwiML immediately. The handler queues async work internally.
		res.status(result.status).type(result.contentType).send(result.body);
	} catch (err) {
		// Last-resort fallback to keep webhook response valid TwiML.
		// (The Express server does similar handling.)
		res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
	}
}

