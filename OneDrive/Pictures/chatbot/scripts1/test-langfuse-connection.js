import "./../loadEnv.js";
import { trackLangfuseEvent } from "./../services/langfuseService.js";

function randomSuffix() {
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function main() {
	const eventName = `langfuse.connection_test.${randomSuffix()}`;
	const metadata = {
		user: "langfuse-connection-test",
		message: `ping-${randomSuffix()}`,
		context: {
			environment: process.env.NODE_ENV || "development"
		}
	};

	console.log("[langfuse-test] Sending test trace-create event...");
	const result = await trackLangfuseEvent(eventName, metadata);

	if (!result) {
		console.error("[langfuse-test] Failed to send (missing LANGFUSE keys or ingestion error).");
		process.exitCode = 1;
		return;
	}

	console.log("[langfuse-test] Sent successfully.");
	console.log("[langfuse-test] EventName:", eventName);
}

await main();

