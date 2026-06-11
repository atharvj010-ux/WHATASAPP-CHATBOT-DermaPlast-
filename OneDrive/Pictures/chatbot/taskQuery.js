const MONTH_INDEX = {
	january: 0,
	jan: 0,
	february: 1,
	feb: 1,
	march: 2,
	mar: 2,
	april: 3,
	apr: 3,
	may: 4,
	june: 5,
	jun: 5,
	july: 6,
	jul: 6,
	august: 7,
	aug: 7,
	september: 8,
	sep: 8,
	october: 9,
	oct: 9,
	november: 10,
	nov: 10,
	december: 11,
	dec: 11
};

export function startOfDay(d) {
	const x = new Date(d);
	x.setHours(0, 0, 0, 0);
	return x;
}

export function endOfDay(d) {
	const x = new Date(d);
	x.setHours(23, 59, 59, 999);
	return x;
}

export function parseSpecificDateFromMessage(message) {
	const dayMonth =
		/(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)(?:\s+(\d{4}))?/i;
	const monthDay =
		/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?/i;

	let match = String(message || "").match(dayMonth);
	let day;
	let monthToken;
	let year;

	if (match) {
		day = Number(match[1]);
		monthToken = match[2];
		year = match[3] ? Number(match[3]) : new Date().getFullYear();
	} else {
		match = String(message || "").match(monthDay);
		if (!match) return null;
		monthToken = match[1];
		day = Number(match[2]);
		year = match[3] ? Number(match[3]) : new Date().getFullYear();
	}

	const month = MONTH_INDEX[monthToken.toLowerCase()];
	if (month === undefined || Number.isNaN(day)) return null;
	return new Date(year, month, day);
}

function formatDateHeading(date) {
	return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function pickEmail(meta) {
	if (!meta || typeof meta !== "object") return null;
	for (const k of ["assignee_email", "user_email", "email"]) {
		const v = meta[k];
		if (typeof v === "string" && v.includes("@")) return v.trim().toLowerCase();
	}
	return null;
}

function isMeLikeDisplay(disp) {
	const x = String(disp ?? "")
		.trim()
		.toLowerCase();
	return x === "" || x === "me" || x === "self";
}

export function taskAssignedToCurrentUser(task, userId, userEmail) {
	const email = userEmail?.trim().toLowerCase() ?? "";
	const metaEmail = pickEmail(task.meta);
	if (email && metaEmail && metaEmail === email) return true;
	if (task.assigned_to !== userId) return false;
	return isMeLikeDisplay(task.assignee_display);
}

export function isCompletedStatus(status) {
	const s = String(status ?? "").toLowerCase().trim();
	return s === "complete" || s === "completed" || s === "done" || s === "closed";
}

export function isPendingStatus(status) {
	const s = String(status ?? "").toLowerCase().trim();
	if (!s) return true;
	if (isCompletedStatus(s)) return false;
	if (s === "cancelled" || s === "canceled" || s === "archived") return false;
	return true;
}

export function parseTaskQuery(message) {
	const t = String(message || "").toLowerCase();
	const mineOnly = /\b(my|mine)\b/.test(t) || /\bassigned to me\b/.test(t);

	const specificDate = parseSpecificDateFromMessage(message);
	const asksSpecificDate =
		Boolean(specificDate) ||
		/\b(?:tasks?|task)\s+(?:on|for)\s+\d{1,2}\b/i.test(message) ||
		/\b(?:on|for)\s+\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january)/i.test(
			message
		);

	if (asksSpecificDate && specificDate) {
		return {
			mode: "specific",
			mineOnly,
			limit: 25,
			specificDate,
			rangeLabel: formatDateHeading(specificDate)
		};
	}

	if (/\boverdue\b/.test(t)) return { mode: "overdue", mineOnly: true, limit: 25, specificDate: null, rangeLabel: null };
	if (/\bpending\b/.test(t) && /task/.test(t))
		return { mode: "pending", mineOnly: true, limit: 25, specificDate: null, rangeLabel: null };
	if (/\bcompleted\b|\bdone\b|\bfinished\b/.test(t))
		return { mode: "completed", mineOnly, limit: 25, specificDate: null, rangeLabel: null };
	if (/\bupcoming\b/.test(t) || /\bnext tasks?\b/.test(t))
		return { mode: "upcoming", mineOnly: true, limit: 25, specificDate: null, rangeLabel: null };
	if (/\btomorrow\b/.test(t)) return { mode: "tomorrow", mineOnly, limit: 25, specificDate: null, rangeLabel: null };
	if (/\btoday\b/.test(t)) return { mode: "today", mineOnly, limit: 25, specificDate: null, rangeLabel: null };
	if (/\byesterday\b/.test(t)) return { mode: "yesterday", mineOnly, limit: 25, specificDate: null, rangeLabel: null };

	return { mode: "all", mineOnly, limit: 20, specificDate: null, rangeLabel: null };
}

function dueOnSameCalendarDay(due, day) {
	return (
		due.getFullYear() === day.getFullYear() &&
		due.getMonth() === day.getMonth() &&
		due.getDate() === day.getDate()
	);
}

export function filterTasksByQuery(rows, parsed) {
	const now = new Date();
	const sod = startOfDay(now);
	const eod = endOfDay(now);

	return rows.filter((r) => {
		const status = r.status;
		const due = r.due_date ? new Date(r.due_date) : null;
		if (!due || !Number.isFinite(due.getTime())) {
			if (parsed.mode === "specific" || parsed.mode === "today" || parsed.mode === "tomorrow") return false;
		}

		switch (parsed.mode) {
			case "specific":
				return Boolean(
					due && parsed.specificDate && dueOnSameCalendarDay(due, parsed.specificDate) && !isCompletedStatus(status)
				);
			case "pending":
				return isPendingStatus(status);
			case "overdue":
				return Boolean(due && due < sod && isPendingStatus(status));
			case "completed":
				return isCompletedStatus(status);
			case "upcoming":
				return Boolean(due && due > now && isPendingStatus(status));
			case "today":
				return Boolean(due && due >= sod && due <= eod && !isCompletedStatus(status));
			case "tomorrow": {
				const t = new Date(sod);
				t.setDate(t.getDate() + 1);
				return Boolean(due && due >= startOfDay(t) && due <= endOfDay(t) && !isCompletedStatus(status));
			}
			case "all":
				return !isCompletedStatus(status);
			default:
				return true;
		}
	});
}

export function sortTasksForDisplay(rows, mode) {
	const copy = [...rows];
	if (mode === "upcoming" || mode === "specific" || mode === "today" || mode === "tomorrow") {
		copy.sort((a, b) => {
			const ad = a.due_date ? new Date(a.due_date).getTime() : Number.MAX_SAFE_INTEGER;
			const bd = b.due_date ? new Date(b.due_date).getTime() : Number.MAX_SAFE_INTEGER;
			return ad - bd;
		});
	}
	return copy;
}

function formatStatusLabel(status) {
	const s = String(status ?? "").trim();
	if (!s) return "N/A";
	if (s.toLowerCase() === "todo") return "Todo";
	if (s.toLowerCase().includes("progress")) return "In Progress";
	if (s.toLowerCase() === "pending") return "Pending";
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDueLabel(iso) {
	const d = new Date(iso);
	if (!Number.isFinite(d.getTime())) return iso;
	const date = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
	const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
	return `${date} – ${time}`;
}

export function formatTaskEmptyMessage(parsed) {
	if (parsed.mode === "specific" && parsed.rangeLabel) {
		return `No tasks found for ${parsed.rangeLabel}.`;
	}
	if (parsed.mode === "upcoming" && parsed.mineOnly) {
		return "No upcoming tasks assigned to you.";
	}
	if (parsed.mineOnly) return "No tasks assigned to you.";
	return "No records found.";
}

export function formatTaskListReply(parsed, rows) {
	const headingMap = {
		all: "Task List",
		pending: "Pending Tasks",
		overdue: "Overdue Tasks",
		completed: "Completed Tasks",
		upcoming: "Upcoming Tasks",
		today: "Today's Tasks",
		tomorrow: "Tomorrow's Tasks",
		yesterday: "Yesterday's Tasks",
		specific: parsed.rangeLabel ? `Tasks for ${parsed.rangeLabel}` : "Tasks"
	};

	const heading = headingMap[parsed.mode] || "Tasks";
	const lines = [heading];

	rows.forEach((r, idx) => {
		if (idx > 0) lines.push("");
		lines.push(String(r.title ?? "Untitled Task"));
		lines.push(`• Priority: ${String(r.priority ?? "N/A")}`);
		lines.push(`• Status: ${formatStatusLabel(r.status)}`);
		lines.push(`• Category: ${String(r.project ?? r.linked_entity_type ?? "General")}`);
		if (r.due_date) lines.push(`• Due: ${formatDueLabel(r.due_date)}`);
	});

	return lines.join("\n").trim();
}

export async function fetchTasksForChatQuery({ supabase, ownerId, userEmail, message }) {
	const parsed = parseTaskQuery(message);
	const now = new Date();
	const sod = startOfDay(now);
	const eod = endOfDay(now);

	let q = supabase
		.from("tasks")
		.select(
			"id,title,description,priority,status,due_date,assigned_to,assignee_display,created_at,updated_at,project,linked_entity_type,meta"
		)
		.or(`owner_id.eq.${ownerId},assigned_to.eq.${ownerId}`);

	if (parsed.mode === "specific" && parsed.specificDate) {
		q = q
			.gte("due_date", startOfDay(parsed.specificDate).toISOString())
			.lte("due_date", endOfDay(parsed.specificDate).toISOString());
	} else if (parsed.mode === "today") {
		q = q.gte("due_date", sod.toISOString()).lte("due_date", eod.toISOString());
	} else if (parsed.mode === "tomorrow") {
		const t = new Date(sod);
		t.setDate(t.getDate() + 1);
		q = q.gte("due_date", startOfDay(t).toISOString()).lte("due_date", endOfDay(t).toISOString());
	} else if (parsed.mode === "upcoming") {
		q = q.gte("due_date", now.toISOString());
	} else if (parsed.mode === "overdue") {
		q = q.lt("due_date", sod.toISOString());
	}

	q = q.order("due_date", { ascending: true, nullsFirst: false }).limit(300);

	const { data, error } = await q;
	if (error) throw error;

	let rows = data || [];

	if (parsed.mineOnly) {
		rows = rows.filter((r) => taskAssignedToCurrentUser(r, ownerId, userEmail));
	}

	rows = filterTasksByQuery(rows, parsed);
	rows = sortTasksForDisplay(rows, parsed.mode);
	rows = rows.slice(0, parsed.limit);

	return { rows, parsed };
}
