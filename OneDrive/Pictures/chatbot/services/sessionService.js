const bookingSessions = new Map();

function logSession(userId, action, detail) {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			channel: "booking-session",
			user: userId,
			action,
			detail
		})
	);
}

export function getBookingSession(userId) {
	return bookingSessions.get(userId) ?? null;
}

export function startBookingSession(userId) {
	const session = {
		mode: "booking",
		step: "name",
		data: {}
	};
	bookingSessions.set(userId, session);
	logSession(userId, "started", { step: session.step });
	return session;
}

export function updateBookingStep(userId, step, dataPatch = {}) {
	const session = getBookingSession(userId);
	if (!session) return null;
	session.step = step;
	if (Object.keys(dataPatch).length) {
		session.data = { ...session.data, ...dataPatch };
	}
	logSession(userId, "updated", { step, data: session.data });
	return session;
}

export function setBookingData(userId, dataPatch) {
	const session = getBookingSession(userId);
	if (!session) return null;
	session.data = { ...session.data, ...dataPatch };
	logSession(userId, "data_updated", { data: session.data });
	return session;
}

export function clearBookingSession(userId) {
	if (bookingSessions.has(userId)) {
		bookingSessions.delete(userId);
		logSession(userId, "cleared", {});
		return true;
	}
	return false;
}

export function isBookingInProgress(userId) {
	return bookingSessions.has(userId);
}
