import { test } from "bun:test";
import assert from "node:assert/strict";
import {
	createReviewQueue,
	enqueueReview,
	resolveReview,
	takeResolved,
	pendingReviews,
	unverifiedCheckpoints,
	describeReviews,
	defaultCodes,
	isUnverified,
} from "./review-queue";

test("a detached review stays pending until its verdict arrives", () => {
	const queue = createReviewQueue();
	const record = enqueueReview(queue, "cp-1", 1_000);
	assert.equal(record.state, "pending");
	assert.deepEqual(pendingReviews(queue).map((r) => r.checkpointId), ["cp-1"]);
	// Enqueueing the same checkpoint again is a retry bump, not a duplicate row.
	assert.equal(enqueueReview(queue, "cp-1", 1_500).asks, 2);
	assert.equal(queue.records.size, 1);
});

test("verdicts resolve once and are announced once", () => {
	const queue = createReviewQueue();
	enqueueReview(queue, "cp-a", 0);
	enqueueReview(queue, "cp-b", 0);
	resolveReview(queue, "cp-a", { valid: true }, 10);
	resolveReview(queue, "cp-b", { valid: false, issues: ["Claim about tokens (not in evidence)"] }, 20);
	assert.equal(queue.records.get("cp-a")?.state, "passed");
	assert.equal(queue.records.get("cp-b")?.state, "rejected");
	const ready = takeResolved(queue);
	assert.deepEqual(ready.map((r) => r.checkpointId).sort(), ["cp-a", "cp-b"]);
	// A second drain must be empty: the rejection cannot spam the chat per turn.
	assert.deepEqual(takeResolved(queue), []);
	assert.deepEqual(unverifiedCheckpoints(queue), ["cp-b"]);
	assert.ok(isUnverified(queue, "cp-b") && !isUnverified(queue, "cp-a") && !isUnverified(queue, undefined));
});

test("a verdict that arrives too late is expired, not rejected", () => {
	// Calling a stale verdict "rejected" would describe a rollback this extension
	// cannot perform.
	const queue = createReviewQueue({ maxAgeMs: 1_000 });
	enqueueReview(queue, "cp-late", 0);
	const record = resolveReview(queue, "cp-late", { valid: false, issues: ["unsupported claim"] }, 5_000);
	assert.equal(record?.state, "expired");
	assert.ok(unverifiedCheckpoints(queue).includes("cp-late"), "expired checkpoints still warn the model");
});

test("issue text maps to content-free codes", () => {
	const codes = defaultCodes([
		"The stated token count (12,345) has no evidence",
		"References file src/foo.ts that was never read",
		"Claims the migration was completed; prerequisite unresolved",
	]);
	assert.ok(codes.includes("numeric-claim"), JSON.stringify(codes));
	assert.ok(codes.includes("file-claim"), JSON.stringify(codes));
	assert.ok(codes.includes("unsupported-claim") || codes.includes("prerequisite-claim"), JSON.stringify(codes));
	// An unclassified rejection must still be visible as a signal.
	assert.deepEqual(defaultCodes(["something is off here"]), ["unspecified"]);
});

test("the queue is bounded and reports its state", () => {
	const queue = createReviewQueue({ maxPerSession: 3 });
	for (const id of ["cp-1", "cp-2", "cp-3", "cp-4"]) enqueueReview(queue, id, 0);
	assert.equal(queue.records.size, 3, "oldest record is evicted");
	assert.ok(!queue.records.has("cp-1"));
	resolveReview(queue, "cp-4", { valid: true }, 1);
	const stats = describeReviews(queue);
	assert.deepEqual(stats, { reviews: 3, pending: 2, passed: 1, rejected: 0, expired: 0, ids: ["cp-2", "cp-3", "cp-4"] });
});
