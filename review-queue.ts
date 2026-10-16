/**
 * Bounded state for evidence reviews that run *after* a checkpoint has already
 * been applied (1.2.6).
 *
 * Why this is a separate module: the review is now detached, so its lifecycle
 * outlives the compaction call that started it. It needs state that survives
 * across turns — which checkpoint is unverified, what the verdict was, whether
 * the model has been told yet — and that state has to be bounded and testable
 * without an LLM in the loop.
 *
 * Privacy: records hold ids, counts, and short verdict codes. Issue *text* comes
 * from the model and is kept only for the user-visible report, never in
 * telemetry.
 */

export type ReviewState = "pending" | "passed" | "rejected" | "expired";

export interface ReviewRecord {
	checkpointId: string;
	state: ReviewState;
	/** ms epoch when the detached ask started. */
	enqueuedAt: number;
	/** ms epoch when the verdict arrived, when it did. */
	resolvedAt?: number;
	/** Number of review asks issued (a rejected checkpoint may get a second). */
	asks: number;
	/** Claims the reviewer flagged, as short codes for telemetry. */
	issueCodes?: string[];
	/** Full issue text for the user-visible report only. */
	issueText?: string;
	/** True once the model has been told this checkpoint failed review. */
	announced?: boolean;
	/** Pi's real compaction entry id, once known (it arrives with session_compact). */
	piCheckpointId?: string;
}

export interface ReviewQueueOptions {
	/** Oldest records are dropped beyond this per-session count. */
	maxPerSession?: number;
	/** A verdict that arrives after this delay is recorded as expired, not rejected. */
	maxAgeMs?: number;
}

export const DEFAULT_MAX_REVIEWS_PER_SESSION = 8;
/**
 * A verdict later than this is no longer actionable: the user has moved on, and
 * labelling it "rejected" would imply a rollback that Pi 1.1.0 cannot perform.
 */
export const DEFAULT_REVIEW_MAX_AGE_MS = 10 * 60 * 1000;

export interface ReviewQueue {
	records: Map<string, ReviewRecord>;
	maxPerSession: number;
	maxAgeMs: number;
}

export function createReviewQueue(options: ReviewQueueOptions = {}): ReviewQueue {
	return {
		records: new Map(),
		maxPerSession: options.maxPerSession ?? DEFAULT_MAX_REVIEWS_PER_SESSION,
		maxAgeMs: options.maxAgeMs ?? DEFAULT_REVIEW_MAX_AGE_MS,
	};
}

/** Register a review ask as in flight. Idempotent: a repeat bumps `asks`. */
export function enqueueReview(queue: ReviewQueue, checkpointId: string, now = Date.now()): ReviewRecord {
	const existing = queue.records.get(checkpointId);
	if (existing) {
		existing.asks++;
		return existing;
	}
	const record: ReviewRecord = { checkpointId, state: "pending", enqueuedAt: now, asks: 1 };
	queue.records.set(checkpointId, record);
	// Map preserves insertion order, so the oldest checkpoint is first.
	while (queue.records.size > queue.maxPerSession) {
		const oldest = queue.records.keys().next();
		if (oldest.done) break;
		queue.records.delete(oldest.value);
	}
	return record;
}

/**
 * Record a verdict. A verdict that arrives after `maxAgeMs` is `expired`: the
 * checkpoint is still in effect, so calling it rejected would describe an action
 * we can no longer take.
 */
export function resolveReview(
	queue: ReviewQueue,
	checkpointId: string,
	verdict: { valid: boolean; issues?: string[]; codes?: string[] },
	now = Date.now(),
): ReviewRecord | undefined {
	const record = queue.records.get(checkpointId);
	if (!record || record.state !== "pending") return record;
	record.resolvedAt = now;
	record.issueCodes = verdict.issues?.length ? verdict.codes ?? defaultCodes(verdict.issues) : verdict.codes;
	record.issueText = verdict.issues?.length ? verdict.issues.join("\n") : undefined;
	record.state = now - record.enqueuedAt > queue.maxAgeMs ? "expired" : verdict.valid ? "passed" : "rejected";
	return record;
}

/** Map free-form reviewer text onto stable, content-free codes. */
export function defaultCodes(issues: string[]): string[] {
	const codes = new Set<string>();
	for (const issue of issues) {
		const lower = issue.toLowerCase();
		if (/not\s*\(|unsupported|no evidence|cannot (be )?verify|unverifiable/.test(lower)) codes.add("unsupported-claim");
		if (/fabricat|invent|hallucinat|made up|does not exist/.test(lower)) codes.add("fabricated");
		if (/file|path|readfiles|modifiedfiles/.test(lower)) codes.add("file-claim");
		if (/token|number|count|version|commit|id\b/.test(lower)) codes.add("numeric-claim");
		if (/prerequisit|not start|not begin|unresolved/.test(lower)) codes.add("prerequisite-claim");
		if (/truncat|incomplete|cut off/.test(lower)) codes.add("truncated");
		if (/contradict|inconsisten/.test(lower)) codes.add("contradiction");
	}
	// Never report an empty code list for a rejection: an unclassified issue still
	// needs to show up in telemetry as a signal.
	return codes.size > 0 ? [...codes].sort() : ["unspecified"];
}

/** Pending reviews for a session, oldest first. */
export function pendingReviews(queue: ReviewQueue): ReviewRecord[] {
	return [...queue.records.values()].filter((record) => record.state === "pending");
}

/**
 * Verdicts that have arrived and still need a user-visible / model-visible
 * consequence. Each record is returned at most once: `announced` is set here so
 * a rejection cannot spam the chat on every subsequent turn.
 */
export function takeResolved(queue: ReviewQueue): ReviewRecord[] {
	const ready = [...queue.records.values()].filter(
		(record) => record.state !== "pending" && !record.announced,
	);
	for (const record of ready) record.announced = true;
	return ready;
}

/** Checkpoints the model must be warned about in the next summary ask. */
export function unverifiedCheckpoints(queue: ReviewQueue): string[] {
	return [...queue.records.values()]
		.filter((record) => record.state === "rejected" || record.state === "expired")
		.map((record) => record.checkpointId);
}

export function describeReviews(queue: ReviewQueue): {
	reviews: number;
	pending: number;
	passed: number;
	rejected: number;
	expired: number;
	ids: string[];
} {
	const records = [...queue.records.values()];
	const count = (state: ReviewState) => records.filter((record) => record.state === state).length;
	return {
		reviews: records.length,
		pending: count("pending"),
		passed: count("passed"),
		rejected: count("rejected"),
		expired: count("expired"),
		ids: records.map((record) => record.checkpointId),
	};
}

/** True when `candidate` is a checkpoint that failed or aged out of review. */
export function isUnverified(queue: ReviewQueue, candidate: string | undefined | null): boolean {
	if (!candidate) return false;
	const record = queue.records.get(candidate);
	return record?.state === "rejected" || record?.state === "expired";
}
