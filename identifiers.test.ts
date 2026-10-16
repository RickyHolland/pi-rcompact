import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
	STRATEGY,
	REPORT_ENTRY,
	REVIEW_ENTRY,
	TELEMETRY_DIRECTORY,
	REQUEST_ADAPTER_SYMBOL,
	REQUEST_DISPATCHER_SYMBOL,
	REQUEST_CLEANUP_SYMBOL,
	READABLE_STRATEGY_ALIASES,
} from "./identifiers";

/**
 * Persisted identifiers are a storage contract and a public surface at the same
 * time: they appear in session files, telemetry paths and issue reports. This
 * check exists so a future edit cannot quietly introduce an identifier that is
 * not derived from the project's own command name.
 */

test("every written identifier is derived from the rcompact command name", () => {
	const written = [STRATEGY, REPORT_ENTRY, REVIEW_ENTRY, REQUEST_ADAPTER_SYMBOL, REQUEST_DISPATCHER_SYMBOL, REQUEST_CLEANUP_SYMBOL];
	for (const value of written) assert.match(value, /^rcompact(\.|[-/])?/, `${value} must start with the project's own name`);
	assert.equal(TELEMETRY_DIRECTORY, "telemetry/rcompact");
});

test("read-only aliases are the only identifiers that predate the current name", () => {
	assert.deepEqual(READABLE_STRATEGY_ALIASES, [STRATEGY, "better-compaction"]);
});

test("runtime identifiers are project-named, not personal", () => {
	// Scope: the TypeScript the extension actually executes. Those string values are
	// what reaches session files, entry types, telemetry paths and global symbol
	// registries, so they must stay derived from the project name — and they must be
	// declared once, in identifiers.ts, rather than repeated at each call site.
	// Test fixtures may use arbitrary labels on purpose (an "unrelated-extension"
	// checkpoint is how the read path gets exercised).
	const files = execFileSync("git", ["ls-files", "--", "*.ts"], { encoding: "utf8" })
		.split("\n")
		.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "identifiers.ts");
	const offenders: string[] = [];
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/["'](rcompact[-./][a-z0-9._-]*|better-compaction[a-z0-9._-]*)["']/g)) {
			offenders.push(`${file}: ${match[1]}`);
		}
	}
	assert.deepEqual(offenders, [], `persisted identifiers must be imported from identifiers.ts: ${offenders.join(", ")}`);
});
