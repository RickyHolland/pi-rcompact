/**
 * Canonical persisted identifiers for rcompact.
 *
 * These values are written into session files, session entries and the telemetry
 * directory, so they are a storage contract: change one and previously written
 * records stop being recognised. Each value is deliberately derived from the
 * `rcompact` command name and nothing else — keep it that way, which is what the
 * naming check in `identifiers.test.ts` enforces.
 */

/** Written into `CompactionResult.details.strategy` and telemetry records. */
export const STRATEGY = "rcompact";

/**
 * Strategy alias from an earlier naming era, still accepted on READ so an old
 * checkpoint in a long-lived session is attributed correctly. Never written.
 */
export const READABLE_STRATEGY_ALIASES = [STRATEGY, "better-compaction"] as const;

/** Custom entry types (report appended after a compaction, review verdict). */
export const REPORT_ENTRY = "rcompact-report";
export const REVIEW_ENTRY = "rcompact-review";

/**
 * Entry-type aliases from earlier naming eras, registered for READ only so an
 * old transcript still renders its report. Never written.
 */
export const READABLE_REPORT_ENTRIES = [REPORT_ENTRY, "better-compaction-report"] as const;

/** Telemetry subdirectory under the Pi agent directory; metadata-only records. */
export const TELEMETRY_DIRECTORY = "telemetry/rcompact";

/**
 * Global-symbol contract names used to share state between module copies of this
 * extension inside one process. `Symbol.for` keys must match every copy that can
 * coexist, so treat them as part of the storage contract as well.
 */
export const REQUEST_ADAPTER_SYMBOL = "rcompact.request-adapter.v1";
export const REQUEST_DISPATCHER_SYMBOL = "rcompact.request-dispatcher.v2";
export const REQUEST_CLEANUP_SYMBOL = "rcompact.request-dispatcher.cleanup.v2";
