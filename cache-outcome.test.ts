import { test } from "bun:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CACHE_MISS_MIN_PROMPT_TOKENS,
	DEFER_COMPACTIONS,
	DEFER_COMPACTIONS_ON_STREAK,
	MISSES_FOR_STREAK,
	EMPTY_CACHE_STATE,
	measureCacheOutcome,
	recordCacheOutcome,
	selectCachePath,
} from "./cache-outcome";

test("a captured ask that read nothing from cache is a miss", () => {
	const miss = measureCacheOutcome({ input: 98_830, output: 500, cacheRead: 0, cacheWrite: 0 });
	assert.equal(miss.measured, true);
	assert.equal(miss.missed, true);
	assert.equal(miss.promptTokens, 98_830);
	const hit = measureCacheOutcome({ input: 12, cacheRead: 98_818, cacheWrite: 0 });
	assert.equal(hit.missed, false);
	assert.equal(hit.promptTokens, 98_830);
});

test("unreported or malformed usage is never evidence of a miss", () => {
	for (const usage of [undefined, null, {}, { input: 0 }, { cacheRead: 0 }, { input: "x", cacheRead: 0 }, {input:9000,cacheRead:null}, {input:"9000",cacheRead:0}, {input:9000,cacheRead:false}, { input: -5, cacheRead: -1 }]) {
		const outcome = measureCacheOutcome(usage);
		assert.equal(outcome.missed, false, JSON.stringify(usage));
	}
	// A silent provider cannot disable the extension through a deferral.
	const state = recordCacheOutcome(EMPTY_CACHE_STATE, measureCacheOutcome({ input: undefined }));
	assert.deepEqual(state, EMPTY_CACHE_STATE);
});

test("small prompts do not count as misses so a short session stays on the captured path", () => {
	assert.equal(measureCacheOutcome({ input: 40, cacheRead: 0 }).missed, false);
	assert.equal(measureCacheOutcome({ input: 40, cacheRead: 0 }, 32).missed, true);
	assert.equal(measureCacheOutcome({ input: 40, cacheRead: 0 }, -1).missed, false);
	assert.equal(measureCacheOutcome({ input: 40, cacheRead: 0 }, undefined).missed, false);
	assert.equal(DEFAULT_CACHE_MISS_MIN_PROMPT_TOKENS, 2048);
});

test("one measured miss defers exactly one compaction, a streak defers longer", () => {
	const miss = measureCacheOutcome({ input: 50_000, cacheRead: 0 });
	let state = recordCacheOutcome(EMPTY_CACHE_STATE, miss);
	assert.deepEqual(state, { misses: 1, deferredFor: DEFER_COMPACTIONS });
	let decision = selectCachePath("defer-after-miss", state, true);
	assert.equal(decision.native, true);
	assert.ok(decision.reason?.includes("read nothing from the prefix cache"));
	assert.equal(decision.state.deferredFor, 0);
	// The probe after the deferral uses the captured ask again.
	assert.equal(selectCachePath("defer-after-miss", decision.state, true).native, false);

	state = recordCacheOutcome(recordCacheOutcome(EMPTY_CACHE_STATE, miss), miss);
	assert.deepEqual(state, { misses: 2, deferredFor: DEFER_COMPACTIONS });
	state = recordCacheOutcome(state, miss);
	assert.equal(state.misses, MISSES_FOR_STREAK);
	assert.equal(state.deferredFor, DEFER_COMPACTIONS_ON_STREAK);
});

test("a measured hit clears the streak", () => {
	const miss = measureCacheOutcome({ input: 50_000, cacheRead: 0 });
	const streak = recordCacheOutcome(recordCacheOutcome(recordCacheOutcome(EMPTY_CACHE_STATE, miss), miss), miss);
	assert.equal(streak.deferredFor, DEFER_COMPACTIONS_ON_STREAK);
	assert.deepEqual(recordCacheOutcome(streak, measureCacheOutcome({ input: 100, cacheRead: 49_900 })), EMPTY_CACHE_STATE);
});

test("policy keep reports misses but never defers; native keeps the captured ask for other engines", () => {
	const state = { misses: 4, deferredFor: DEFER_COMPACTIONS_ON_STREAK };
	for (const policy of ["keep", "native"] as const) {
		const decision = selectCachePath(policy, state, true);
		assert.equal(decision.native, policy === "native");
		assert.deepEqual(decision.state, state, policy);
	}
	// Reconstructed-prefix compactions are not this policy's subject.
	for (const policy of ["defer-after-miss", "keep", "native"] as const) {
		const decision = selectCachePath(policy, state, false);
		assert.equal(decision.native, false, policy);
		assert.deepEqual(decision.state, state, policy);
	}
});

test("deferral state is consumed only on the captured path and survives unmeasured usage", () => {
	let state = recordCacheOutcome(undefined, measureCacheOutcome({ input: 9000, cacheRead: 0 }));
	assert.equal(state.deferredFor, DEFER_COMPACTIONS);
	state = selectCachePath("defer-after-miss", state, true).state;
	assert.equal(state.deferredFor, 0);
	state = selectCachePath("defer-after-miss", state, true).state;
	assert.equal(state.deferredFor, 0);
	assert.equal(state.misses, 1);
});
