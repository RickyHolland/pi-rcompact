import { test } from "bun:test";
import assert from "node:assert/strict";
import {
	createRecallArchive,
	journalScope,
	readJournalEntry,
	toRecallMessage,
	searchRecall,
	renderHits,
	renderGenerations,
	MAX_RECALL_LIMIT,
	type RecallGeneration,
} from "./recall-archive";

function msg(role: string, text: string, extra: any[] = []) {
	return { role, content: [{ type: "text", text }, ...extra] };
}

test("flattens text, keeps tool call names and arguments, drops thinking", () => {
	const plain = toRecallMessage(msg("user", "the vault password is hunter2"));
	assert.equal(plain?.role, "user");
	assert.equal(plain?.text, "the vault password is hunter2");
	// Thinking-only messages contribute no evidence text: a recalled chain of
	// thought would be presented as settled fact. The journal still reports that
	// something opaque lives there, so a reader knows the entry is not empty.
	const reasoningOnly = toRecallMessage({ role: "assistant", content: [{ type: "thinking", thinking: "hidden chain" }] });
	assert.equal(reasoningOnly?.text, "", "reasoning text is never surfaced as evidence");
	assert.match(reasoningOnly?.opaque?.join(",") ?? "", /^reasoning:12 chars/);
	assert.equal(toRecallMessage({ role: "user", content: [] }), undefined);
	const call = toRecallMessage({
		role: "assistant",
		content: [{ type: "toolCall", name: "bash", arguments: { command: "grep -r hunter2 ." } }],
	});
	assert.deepEqual(call?.tools, ["bash"]);
	assert.match(call?.text ?? "", /grep -r hunter2 \./);
	const result = toRecallMessage({ role: "toolResult", content: [{ type: "text", text: "matches: 3" }] });
	assert.equal(result?.text, "matches: 3");
});

test("caps archived generations and bytes in memory", () => {
	const small = createRecallArchive({ maxGenerations: 2 });
	small.archive("g1", [msg("user", "alpha alpha alpha alpha")]);
	small.archive("g2", [msg("user", "bravo bravo bravo bravo")]);
	small.archive("g3", [msg("user", "charlie charlie charlie")]);
	assert.deepEqual(small.describe().ids, [2, 3]);
	assert.equal(small.search({ pattern: "alpha" }).length, 0, "the evicted generation must not be recallable");
	assert.equal(small.search({ pattern: "charlie" }).length, 1);

	const byteCapped = createRecallArchive({ maxGenerations: 10, maxBytes: 200 });
	byteCapped.archive("g1", [msg("user", "x".repeat(500))]);
	byteCapped.archive("g2", [msg("user", "y".repeat(500))]);
	assert.deepEqual(byteCapped.describe().ids, [], "an oversized generation must not bypass the byte cap");
	assert.ok(byteCapped.describe().bytes <= 200);
	byteCapped.archive("fits", [msg("user", "small")]);
	assert.equal(byteCapped.archive("oversized", [msg("user", "z".repeat(500))]), undefined);
	assert.equal(byteCapped.search({pattern:"small"}).length,1,"oversized input must preserve older usable evidence");
	small.drop();
	assert.equal(small.describe().bytes, 0);
	assert.equal(small.describe().generations, 0);
});

test("searches newest generation first and scopes with fromGeneration", () => {
	const two = createRecallArchive();
	two.archive("older", [msg("user", "the cut off date is March")]);
	two.archive("newer", [msg("user", "the cut off date is April")]);
	const both = two.search({ pattern: "cut off date" });
	assert.equal(both.length, 2);
	assert.equal(both[0].generation, 2, "the most recent checkpoint is usually what the model just lost");
	assert.match(both[0].snippet, /April/);
	assert.deepEqual(
		two.search({ pattern: "cut off date", fromGeneration: 1 }).map((hit) => hit.generation),
		[2, 1],
	);
	assert.equal(two.search({ pattern: "cut off date", fromGeneration: 2 }).length, 1);
	assert.match(renderGenerations(two.generations as RecallGeneration[]), /gen 2: 1 archived messages/);
});

test("literal search is case-insensitive unless asked, alternatives are OR", () => {
	const two = createRecallArchive();
	two.archive("dates", [msg("user", "the cut off date is April"), msg("assistant", "March was the earlier deadline")]);
	assert.equal(two.search({ pattern: "APRIL" }).length, 1);
	assert.equal(two.search({ pattern: "APRIL", caseSensitive: true }).length, 0);
	assert.equal(two.search({ pattern: "April", caseSensitive: true }).length, 1);
	assert.equal(searchRecall(two.generations, { patterns: ["March", "April"] }).length, 2);
	// Empty/absent patterns return nothing rather than matching everything.
	assert.equal(two.search({ pattern: "" }).length, 0);
	assert.equal(two.search({} as any).length, 0);
});

test("filters by role and tool, clamps the hit limit", () => {
	const roles = createRecallArchive();
	roles.archive("mixed", [
		msg("user", "ERROR: disk full"),
		msg("assistant", "I will check the logs", [{ type: "toolCall", name: "bash", arguments: { command: "df -h" } }]),
		{ role: "toolResult", content: [{ type: "text", text: "ERROR: 100% used" }] },
	]);
	assert.equal(roles.search({ pattern: "ERROR" }).length, 2);
	assert.equal(roles.search({ pattern: "ERROR", roles: ["assistant"] }).length, 0);
	assert.equal(roles.search({ pattern: "ERROR", roles: ["toolResult"] }).length, 1);
	assert.deepEqual(roles.search({ pattern: "check", toolNames: ["bash"] }).map((hit) => hit.role), ["assistant"]);
	assert.equal(roles.search({ pattern: "eRROR", isRegex: true, limit: 1 }).length, 1);
	assert.equal(roles.search({ pattern: "ERROR", limit: 999 }).length, 2, "only two messages match");
	assert.equal(roles.search({ pattern: "ERROR", limit: 0 }).length, 1, "limit is clamped to at least one hit");
	assert.ok(MAX_RECALL_LIMIT >= 2);
});

test("reports an invalid regex instead of throwing", () => {
	const archive = createRecallArchive();
	archive.archive("g", [msg("user", "ERROR: disk full")]);
	let patternError: string | undefined;
	const hits = searchRecall(archive.generations, { pattern: "([unclosed", isRegex: true }, undefined, (message) => {
		patternError = message;
	});
	assert.equal(hits.length, 0);
	assert.match(patternError ?? "", /Invalid regular expression/);
});

test("excerpt centers on the match and marks shortened snippets", () => {
	const long = createRecallArchive();
	long.archive("long", [msg("user", "a".repeat(5000) + " NEEDLE " + "b".repeat(5000))]);
	const found = long.search({ pattern: "NEEDLE", snippetChars: 300 })[0];
	assert.ok(found.truncated, "a shortened snippet must say so");
	assert.ok(found.snippet.length <= 302, `snippet was ${found.snippet.length}`);
	assert.match(found.snippet, /NEEDLE/, "the excerpt must be centered on the match, not the message head");
	assert.equal(long.search({ pattern: "NEEDLE" })[0].snippet.includes("NEEDLE"), true);
	assert.match(renderHits(long.search({ pattern: "NEEDLE" })), /^\[gen 1 msg 0 role=user\]/);
});

test("empty states say so instead of implying lost evidence", () => {
	assert.equal(renderHits([]), "No archived message matches. Use recall_generations to see what is archived.");
	assert.equal(renderGenerations([]), "Nothing archived yet: no compaction has run since this process started.");
	// An empty compaction range archives nothing, so the tool never claims a
	// generation that has no evidence in it.
	const empty = createRecallArchive();
	assert.equal(empty.archive("nothing", []), undefined);
	assert.equal(empty.describe().generations, 0);
	assert.equal(empty.search({ pattern: "anything" }).length, 0);
});

console.log("recall-archive: ok");

test("stored journal mode reads raw entries by id, pages, and stays read-only", () => {
	const entries = [
		{ id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: "the raw secret REDACT_ME" }] } },
		{ id: "e2", type: "custom", customType: "artifact" },
		{ id: "e3", type: "compaction", summary: "checkpoint" },
		{ id: "e4", type: "message", message: { role: "assistant", content: [{ type: "text", text: "after the checkpoint" }] } },
	];
	const manager = {
		getBranch: () => entries,
		getEntry: (id) => entries.find((entry) => entry.id === id),
	};
	const scope = journalScope(manager);
	assert(scope.messages.length === 1, "only pre-boundary messages are recallable");
	assert(scope.messages[0]!.entryId === "e1", "journal hits carry the stored entry id");
	assert(scope.boundaryId === "e3", "the newest compaction is the boundary");
	assert(scope.skipped.includes("e2:custom"), "non-message entries are reported, not silently dropped");
	// Reading by id must page and must not mutate the journal.
	const page = readJournalEntry(manager, "e1", 4, 10);
	assert(page?.text === "raw secret", `paged read returned ${JSON.stringify(page?.text)}`);
	assert(page?.totalChars === 24, `total chars ${page?.totalChars}`);
	assert(readJournalEntry(manager, "e3")?.text.startsWith("[entry e3 type=compaction"), "compaction entries read as a note");
	assert(entries[0]!.message.content[0]!.text === "the raw secret REDACT_ME", "journal reads are read-only");
	// Images and reasoning stay opaque: presence is reported, content is not surfaced.
	const opaqueScope = journalScope({
		getBranch: () => [
			{ id: "v1", type: "message", message: { role: "user", content: [{ type: "image" }, { type: "thinking", thinking: "private draft" }] } },
		],
		getEntry: () => undefined,
	});
	assert(opaqueScope.messages[0]?.opaque?.some((note) => note.startsWith("reasoning:")), "reasoning reported as opaque");
	assert(opaqueScope.messages[0]?.text === "", "thinking text is not surfaced as evidence");
});
