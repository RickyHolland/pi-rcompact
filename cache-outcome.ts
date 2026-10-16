/**
 * Cache-miss feedback for the captured-request strategy.
 *
 * A captured-request ask sends the whole live conversation because the prefix
 * is supposed to be free. When the server reports it read nothing from cache,
 * the engine dropped that resident state (unload, eviction, competing request)
 * and the ask paid a cold prefill of the entire context. Repeating that shape
 * is worse than Pi's own small serialized summary, so a measured miss hands the
 * next compaction back to native and re-probes afterwards.
 *
 * Missing or malformed usage is never treated as a miss: a provider that
 * reports nothing must not be able to disable the extension.
 */
export type CachePolicy = "defer-after-miss" | "keep" | "native";

export const DEFAULT_CACHE_MISS_MIN_PROMPT_TOKENS = 2048;
/** Compactions handed to native after one measured miss. */
export const DEFER_COMPACTIONS = 1;
/** A longer streak defers more compactions before probing again. */
export const DEFER_COMPACTIONS_ON_STREAK = 5;
export const MISSES_FOR_STREAK = 3;

export interface CacheOutcome {
	cacheRead: number;
	promptTokens: number;
	missed: boolean;
	/** False when the provider reported no usable usage at all. */
	measured: boolean;
}

export interface CacheState {
	/** Consecutive measured misses; cleared by any measured hit. */
	misses: number;
	/** Remaining compactions to hand back to native. */
	deferredFor: number;
}

export const EMPTY_CACHE_STATE: CacheState = { misses: 0, deferredFor: 0 };

function nonNegative(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : NaN;
	return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** Read the prefix-cache outcome from one summarization response. */
export function measureCacheOutcome(usage: unknown, minPromptTokens = DEFAULT_CACHE_MISS_MIN_PROMPT_TOKENS): CacheOutcome {
	const cacheRead = nonNegative((usage as CacheOutcome | undefined)?.cacheRead);
	const input = nonNegative((usage as { input?: unknown } | undefined)?.input);
	if (cacheRead === undefined || input === undefined) {
		return { cacheRead: 0, promptTokens: 0, missed: false, measured: false };
	}
	const cacheWrite = nonNegative((usage as { cacheWrite?: unknown } | undefined)?.cacheWrite) ?? 0;
	const promptTokens = input + cacheRead + cacheWrite;
	const minimum = nonNegative(minPromptTokens) ?? DEFAULT_CACHE_MISS_MIN_PROMPT_TOKENS;
	return { cacheRead, promptTokens, missed: cacheRead === 0 && promptTokens >= minimum, measured: true };
}

/** Fold one measured outcome into the per-session streak. */
export function recordCacheOutcome(state: CacheState | undefined, outcome: CacheOutcome): CacheState {
	const current = state ?? EMPTY_CACHE_STATE;
	if (!outcome.measured) return current;
	if (!outcome.missed) return EMPTY_CACHE_STATE;
	const misses = current.misses + 1;
	return { misses, deferredFor: misses >= MISSES_FOR_STREAK ? DEFER_COMPACTIONS_ON_STREAK : DEFER_COMPACTIONS };
}

export interface CacheDecision {
	/** True when this compaction must not use the captured-request ask. */
	native: boolean;
	reason?: string;
	/** State to store for the session; the deferral is consumed here. */
	state: CacheState;
}

/**
 * Decide the ask shape for one compaction. Only the captured path defers: the
 * reconstructed-prefix path used by other APIs never claims a cache hit.
 */
export function selectCachePath(policy: CachePolicy, state: CacheState | undefined, capturedPath: boolean): CacheDecision {
	const current = state ?? EMPTY_CACHE_STATE;
	if (!capturedPath) return { native: false, state: current };
	if (policy === "native") {
		return { native: true, reason: "cache policy keeps the captured request for summary-free engines only", state: current };
	}
	if (policy === "keep" || current.deferredFor <= 0) return { native: false, state: current };
	return {
		native: true,
		reason: `previous captured-request compaction read nothing from the prefix cache (${current.deferredFor} deferred)`,
		// Consumed whether or not this compaction completes: a native summary
		// still re-prefills the conversation, so the next probe is informative.
		state: { misses: current.misses, deferredFor: current.deferredFor - 1 },
	};
}
