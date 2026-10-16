/**
 * better-compaction report lifecycle tests.
 *
 * Regression guard for the post-compaction report: it must be appended as a
 * custom session entry (persistent in the chat, never sent to the LLM) on pi's
 * `session_compact` event (which fires only after pi has applied the
 * compaction result), NOT inside `session_before_compact` — and only for
 * compactions this extension actually produced.
 *
 * Run with: bun test
 */
/// <reference types="bun-types" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import extension from "./compaction";
import { STRATEGY, REPORT_ENTRY, REVIEW_ENTRY} from "./identifiers";
import {buildSessionProjection, convertToLlm, SessionManager} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Mock harness
// ---------------------------------------------------------------------------

interface ApiMock {
	/** event → handler (in registration order) */
	handlers: Map<string, unknown[]>;
	/** entries appended via pi.appendEntry, in order */
	entries: Array<{ customType: string; data?: unknown }>;
	on: (event: string, handler: unknown) => () => void;
	registerCommand: (name: string, def: unknown) => void;
	registerEntryRenderer: (customType: string, renderer: unknown) => void;
	appendEntry: (customType: string, data?: unknown) => void;
}

function createApiMock(): ApiMock {
	const handlers = new Map<string, unknown[]>();
	const entries: Array<{ customType: string; data?: unknown }> = [];
	return {
		handlers,
		entries,
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const i = list.indexOf(handler);
				if (i >= 0) list.splice(i, 1);
			};
		},
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		appendEntry: (customType, data) => {
			entries.push({ customType, data });
		},
	};
}

/** Fire the (single) handler registered for `event` and return its result. */
async function fire(api: ApiMock, event: string, eventPayload: unknown, ctx: unknown) {
	const list = api.handlers.get(event);
	expect(list, `no handler registered for ${event}`).toBeDefined();
	const handler = list![list!.length - 1] as (e: unknown, c: unknown) => unknown;
	return handler(eventPayload, ctx);
}

// ---------------------------------------------------------------------------
// Session entry / stream fixtures
// ---------------------------------------------------------------------------

function makeEntries(): { entries: unknown[]; leafId: string; keptEntryId: string } {
	const mk = (i: number, message: unknown) => ({
		type: "message",
		id: `entry-${i}`,
		parentId: i === 0 ? null : `entry-${i - 1}`,
		timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
		message,
	});
	const user = (text: string) => ({
		role: "user" as const,
		content: text,
		timestamp: Date.now(),
	});
	const assistant = (text: string) => ({
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-completions" as const,
		provider: "test",
		model: "test-model",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop" as const,
		timestamp: Date.now(),
	});
	const entries = [
		mk(0, user("Read the codebase and tell me what it does.")),
		mk(1, assistant("It is a small CLI tool.")),
		mk(2, user("Now add a config file option.")), // firstKeptEntryId — cut point
		mk(3, assistant("Done, added --config.")),
		mk(4, user("Great, commit it.")),
	];
	return { entries, leafId: "entry-4", keptEntryId: "entry-2" };
}

function makePreparation(keptEntryId: string) {
	return {
		firstKeptEntryId: keptEntryId,
		messagesToSummarize: [] as unknown[],
		turnPrefixMessages: [] as unknown[],
		isSplitTurn: false,
		tokensBefore: 123_456,
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		settings: { reserveTokens: 20_000 },
	};
}

function makeSummaryMessage(overrides?: {
	cacheRead?: number;
	stopReason?: "stop" | "error";
	errorMessage?: string;
	text?: string;
}) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: overrides?.text ?? "## Goal\nKeep the test green.\n## Constraints & Preferences\n(none)\n## Progress\nTests complete.\n## Key Decisions\n(none)\n## Next Steps\nContinue.\n## Critical Context\n(none)" }],
		api: "openai-completions" as const,
		provider: "test",
		model: "test-model",
		usage: {
			input: 100,
			output: 40,
			cacheRead: overrides?.cacheRead ?? 12_345,
			cacheWrite: 0,
		},
		stopReason: overrides?.stopReason ?? ("stop" as const),
		...(overrides?.errorMessage ? { errorMessage: overrides.errorMessage } : {}),
		timestamp: Date.now(),
	};
}

/** Fake LLM stream with a ~300ms thinking span so the report shows the split. */
function makeStream(message: unknown) {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "thinking_start" };
			await sleep(300);
			yield { type: "thinking_end" };
			yield { type: "done", message };
		},
	};
}

/**
 * Fake LLM stream in the order the OpenAI-compatible adapter actually emits:
 * thinking_start … text_start (answer begins) … then thinking_end ONLY at
 * stream end (blocks are finalized in bulk after the SSE loop).
 */
function makeOpenAiOrderStream(message: unknown) {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "thinking_start" };
			await sleep(300);
			yield { type: "text_start" };
			await sleep(600);
			yield { type: "thinking_end" }; // late: only at stream end
			yield { type: "done", message };
		},
	};
}

function makeCtx(opts: {
	sessionId: string;
	cwd: string;
	notify: (message: string, type?: string) => void;
	/** produce() results, consumed one per streamSimple call */
	messages: unknown[];
	hasUI?: boolean;
	/** stream shape used by the fake streamSimple (default: makeStream) */
	streamFactory?: (message: unknown) => unknown;
}) {
	const { entries, leafId } = makeEntries();
	const calls: unknown[][] = [];
	return {
		calls,
		model: {
			id: "test-model",
			provider: "test",
			cost: {input:0,cacheRead:0},
			maxTokens: 8192,
			reasoning: true,
		},
		modelRegistry: {
			streamSimple: async (...args: unknown[]) => {
				calls.push(args);
				const msg = opts.messages.shift() ?? makeSummaryMessage();
				return (opts.streamFactory ?? makeStream)(msg);
			},
		},
		sessionManager: {
			getEntries: () => entries,
            getBranch() { return this.getEntries(); },
			getLeafId: () => leafId,
			getSessionId: () => opts.sessionId,
		},
		cwd: opts.cwd,
		hasUI: opts.hasUI ?? true,
		thinkingLevel: "off",
		signal: new AbortController().signal,
		ui: { notify: opts.notify },
	};
}

function beforeCompactEvent(keptEntryId: string) {
	return {
		type: "session_before_compact",
		preparation: makePreparation(keptEntryId),
		branchEntries: [],
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	};
}

function compactEvent() {
	return {
		type: "session_compact",
		compactionEntry: { type: "compaction", id: "c1", parentId: null, timestamp: "" },
		fromExtension: true,
		reason: "manual",
		willRetry: false,
	};
}

function compactFailedEvent() {
	return {
		type: "session_compact_failed",
		reason: "manual",
		errorMessage: "boom",
		aborted: false,
		willRetry: false,
		fromExtension: true,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmp: string;
let projectDir: string;

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "bc-test-"));
	// Legacy lifecycle tests isolate one generation call; verification is covered by SDK integration.
	process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR);
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR,"settings.json"),JSON.stringify({betterCompaction:{verify:false}}));
	projectDir = join(tmp, "project");
	mkdirSync(projectDir);
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function freshExtension(): ApiMock {
	const api = createApiMock();
	extension(api as never);
	return api;
}

describe("post-compaction report lifecycle", () => {
	test("is NOT emitted during session_before_compact, only on session_compact", async () => {
		const api = freshExtension();
		const ctx = makeCtx({ sessionId: "s1", cwd: projectDir, notify: () => {}, messages: [] });

		// Summarization runs and the compaction result is returned…
		const result = await fire(api, "session_before_compact", beforeCompactEvent("entry-2"), ctx);
		expect(result).toBeDefined();
		const compaction = (result as { compaction: Record<string, unknown> }).compaction;
		expect(compaction.details).toMatchObject({ strategy: STRATEGY });
		expect(compaction.firstKeptEntryId).toBe("entry-2");
		expect(compaction.tokensBefore).toBe(123_456);
		expect(String(compaction.summary)).toContain("## Goal");
		// …but nothing is reported yet: the compaction is not complete.
		expect(api.entries).toEqual([]);

		// …and the report entry appears exactly when pi says the compaction
		// succeeded, with the final attempt's numbers.
		await fire(api, "session_compact", compactEvent(), ctx);
		expect(api.entries).toHaveLength(1);
		expect(api.entries[0]!.customType).toBe(REPORT_ENTRY);
		expect(api.entries[0]!.data).toMatchObject({ cacheRead: 12_345 });

		// …and never again for the same compaction.
		await fire(api, "session_compact", compactEvent(), ctx);
		expect(api.entries).toHaveLength(1);
	});

	test("reports the final attempt's timing after a retried summarization", async () => {
		const api = freshExtension();
		const messages: string[] = [];
		const cwd = join(tmp, "retry-project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		// Fast retry so the test stays quick.
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 10, maxAgentDelayMs: 100 } }),
		);
		// First attempt fails with a retryable error, second succeeds with
		// different (final) usage — the report must reflect the final attempt.
		const ctx = makeCtx({
			sessionId: "s2",
			cwd,
			notify: (m) => messages.push(m),
			messages: [
				makeSummaryMessage({ stopReason: "error", errorMessage: "overloaded, please retry" }),
				makeSummaryMessage({ cacheRead: 55, text: makeSummaryMessage().content[0].text.replace("Keep the test green.", "Final attempt summary.") }),
			],
		});

		const result = await fire(api, "session_before_compact", beforeCompactEvent("entry-2"), ctx);
		expect((result as { compaction: { summary: string } }).compaction.summary).toContain("Final attempt");
		expect(api.entries).toEqual([]);

		await fire(api, "session_compact", compactEvent(), ctx);
		expect(api.entries).toHaveLength(1);
		expect(api.entries[0]!.customType).toBe(REPORT_ENTRY);
		// Must be the final attempt's usage (55), not attempt 1's 12_345.
		expect(api.entries[0]!.data).toMatchObject({ cacheRead: 55 });
	});

	test("does not report for pi's built-in compaction (no stashed report)", async () => {
		const api = freshExtension();
		const ctx = makeCtx({ sessionId: "s3", cwd: projectDir, notify: () => {}, messages: [] });

		// session_compact without a preceding session_before_compact result
		// (i.e. pi's built-in compaction ran) → no report.
		await fire(api, "session_compact", compactEvent(), ctx);
		expect(api.entries).toEqual([]);
	});

	test("discards the stashed report when the compaction fails", async () => {
		const api = freshExtension();
		const ctx = makeCtx({ sessionId: "s4", cwd: projectDir, notify: () => {}, messages: [] });

		// Summarization succeeded (report stashed) but the compaction then fails.
		const result = await fire(api, "session_before_compact", beforeCompactEvent("entry-2"), ctx);
		expect(result).toBeDefined();
		await fire(api, "session_compact_failed", compactFailedEvent(), ctx);
		expect(api.entries).toEqual([]);

		// A later successful compaction in the same session must not emit the
		// stale report from the failed one (built-in path → nothing stashed).
		await fire(api, "session_compact", compactEvent(), ctx);
		expect(api.entries).toEqual([]);
	});

	test("respects report=false (set at emit time)", async () => {
		const api = freshExtension();
		const cwd = join(tmp, "report-off");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ betterCompaction: { report: false } }));
		const ctx = makeCtx({ sessionId: "s5", cwd, notify: () => {}, messages: [] });

		const result = await fire(api, "session_before_compact", beforeCompactEvent("entry-2"), ctx);
		expect(result).toBeDefined(); // summary is still produced…
		await fire(api, "session_compact", compactEvent(), ctx);
		expect(api.entries).toEqual([]); // …but the report is suppressed
	});

	test("persists the report entry even when there is no UI", async () => {
		const api = freshExtension();
		const ctx = makeCtx({
			sessionId: "s6",
			cwd: projectDir,
			notify: () => {},
			messages: [],
			hasUI: false,
		});

		const result = await fire(api, "session_before_compact", beforeCompactEvent("entry-2"), ctx);
		expect(result).toBeDefined();
		await fire(api, "session_compact", compactEvent(), ctx);
		// The report is a session entry, not a notification: no UI is needed,
		// and it renders whenever the session is viewed interactively.
		expect(api.entries).toHaveLength(1);
		expect(api.entries[0]!.customType).toBe(REPORT_ENTRY);
	});

	test("keeps reports isolated per session", async () => {
		const api = freshExtension();
		const ctxA = makeCtx({ sessionId: "sA", cwd: projectDir, notify: () => {}, messages: [] });
		const ctxB = makeCtx({ sessionId: "sB", cwd: projectDir, notify: () => {}, messages: [] });

		await fire(api, "session_before_compact", beforeCompactEvent("entry-2"), ctxA);
		await fire(api, "session_before_compact", beforeCompactEvent("entry-2"), ctxB);

		// Session A's completion must not consume or duplicate session B's report.
		await fire(api, "session_compact", compactEvent(), ctxA);
		expect(api.entries).toHaveLength(1);

		await fire(api, "session_compact", compactEvent(), ctxB);
		expect(api.entries).toHaveLength(2);
	});

	test("closes the thinking span at text_start (OpenAI adapters emit thinking_end only at stream end)", async () => {
		const api = freshExtension();
		const ctx = makeCtx({
			sessionId: "s7",
			cwd: projectDir,
			notify: () => {},
			messages: [],
			streamFactory: makeOpenAiOrderStream,
		});

		await fire(api, "session_before_compact", beforeCompactEvent("entry-2"), ctx);
		await fire(api, "session_compact", compactEvent(), ctx);
		expect(api.entries).toHaveLength(1);
		const data = api.entries[0]!.data as { totalMs: number; thinkingMs: number };
		// The thinking span must end at text_start (~300ms), not at the late
		// thinking_end (~900ms): the 600ms tail is the answer being generated.
		// (With the old code thinkingMs ≈ 900 and "generating" ≈ 0.)
		expect(data.thinkingMs).toBeLessThan(600);
		// Allow timer millisecond quantization at the 600ms fixture boundary.
		assert.ok(data.totalMs - data.thinkingMs >= 500);
	});
});


describe("Splash compatibility and summary integrity", () => {
  const quickStream = (message: unknown) => ({async *[Symbol.asyncIterator]() {yield {type:"done",message};}});
  function setup(name: string, messages: unknown[]) {
    const cwd=join(tmp,name);
    mkdirSync(join(cwd,".pi"),{recursive:true});
    writeFileSync(join(cwd,".pi","settings.json"),JSON.stringify({betterCompaction:{enabled:true,thinking:"inherit",lowThinkingBudget:0},retry:{enabled:false}}));
    const api=freshExtension();
    const notices:string[]=[];
    const ctx=makeCtx({sessionId:name,cwd,notify:m=>notices.push(m),messages,streamFactory:quickStream});
    ctx.model.provider="test";ctx.thinkingLevel="medium";
    return {api,ctx,notices,cwd};
  }
  async function primeCapture(api:any,ctx:any) {
    let registered:any;
    const provider={streamSimple:(_m:any,_c:any,o:any)=>o.onPayload({messages:[{role:"user",content:"Ordinary captured fixture"}]})};
    api.registerProvider=(_id:string,config:any)=>{registered=config};
    ctx.model.api="openai-completions";
    ctx.modelRegistry.getProvider=()=>registered??provider;
    for(const h of api.handlers.get("before_agent_start")??[])await h({},ctx);
    for(const h of api.handlers.get("context_with_system")??[])await h({},ctx);
    const projection=buildSessionProjection(ctx.sessionManager.getEntries(),ctx.sessionManager.getLeafId());
    await registered.streamSimple(ctx.model,{messages:convertToLlm(projection.messages)}, {sessionId:ctx.sessionManager.getSessionId(),reasoning:ctx.thinkingLevel,onPayload:async(body:any)=>{for(const h of api.handlers.get("before_provider_request")??[])await h({payload:body},ctx);return body;}});
    for(const h of api.handlers.get("message_end")??[])await h({message:{role:"assistant",provider:ctx.model.provider,model:ctx.model.id,stopReason:"stop",usage:{input:12000,cacheRead:0}}},ctx);
  }
  test("Splash without a final request capture yields safely to native", async()=>{
    const {api,ctx,notices}=setup("missing-capture",[]);ctx.model.provider="splash";ctx.model.api="openai-completions";
    assert.equal(await fire(api,"session_before_compact",beforeCompactEvent("entry-2"),ctx),undefined);
    assert.equal(ctx.calls.length,0);assert.ok(notices[0].includes("no ordinary request captured"));
    await fire(api,"session_before_compact",beforeCompactEvent("entry-2"),ctx);assert.equal(notices.length,1);
  });
  test("inherits reasoning on ordinary providers",async()=>{
    const {api,ctx}=setup("reasoning-options",[]);
    await fire(api,"session_before_compact",beforeCompactEvent("entry-2"),ctx);
    assert.equal((ctx.calls[0][2] as any).reasoning,"medium");
  });
  for(const [name,alter] of [
    ["empty",(m:any)=>{m.content=[{type:"text",text:""}];}],
    ["missing-sections",(m:any)=>{m.content=[{type:"text",text:"I will continue coding."}];}],
    ["truncated",(m:any)=>{m.stopReason="length";}],
    ["truncated-tool",(m:any)=>{m.stopReason="length";m.content.push({type:"toolCall",id:"x",name:"write",arguments:{}});}],
    ["aborted",(m:any)=>{m.stopReason="aborted";}],
    ["error",(m:any)=>{m.stopReason="error";m.errorMessage="invalid fixture";}],
    ["tool-with-text",(m:any)=>{m.content.push({type:"toolCall",id:"x",name:"write",arguments:{}});}]
  ] as const) {
    test(`cancels ${name} without summary or success report`,async()=>{
      const m=makeSummaryMessage();alter(m);
      const {api,ctx,notices}=setup(`bad-${name}`,[m,structuredClone(m)]);
      const result=await fire(api,"session_before_compact",beforeCompactEvent("entry-2"),ctx);
      assert.deepEqual(result,{cancel:true});
      assert.ok(notices.at(-1)?.includes("original context retained"));
      await fire(api,"session_compact",compactEvent(),ctx);
      assert.deepEqual(api.entries,[]);
    });
  }
  test("preserves file tracking",async()=>{
    const {api,ctx}=setup("file-tracking",[]);
    const event=beforeCompactEvent("entry-2");
    event.preparation.fileOps.read.add("/tmp/read-only.js");
    event.preparation.fileOps.read.add("/tmp/edited.js");
    event.preparation.fileOps.edited.add("/tmp/edited.js");
    const result:any=await fire(api,"session_before_compact",event,ctx);
    assert.deepEqual(result.compaction.details.readFiles,["/tmp/read-only.js"]);
    assert.deepEqual(result.compaction.details.modifiedFiles,["/tmp/edited.js"]);
    assert.ok(result.compaction.summary.includes("<modified-files>\n/tmp/edited.js"));
  });
  for (const [name,details,expectedReads,expectedEdits] of [
    ["own",{strategy:STRATEGY,readFiles:["/tmp/previous.js","/tmp/newly-edited.js"],modifiedFiles:["/tmp/old-edited.js"]},["/tmp/previous.js"],["/tmp/newly-edited.js","/tmp/old-edited.js"]],
    ["legacy",{strategy:"better-compaction",readFiles:[],modifiedFiles:["/tmp/old-edited.js"]},[],["/tmp/newly-edited.js","/tmp/old-edited.js"]],
    ["unrelated",{strategy:"unrelated-extension",readFiles:["/tmp/private.js"],modifiedFiles:["/tmp/unrelated.js"]},[],["/tmp/newly-edited.js"]],
    ["malformed",{strategy:STRATEGY,readFiles:7,modifiedFiles:[null,17,{},"","/tmp/valid.js"]},[],["/tmp/newly-edited.js","/tmp/valid.js"]],
  ] as const) {
    test(`cumulative metadata uses latest projected checkpoint: ${name}`,async()=>{
      const {api,ctx,cwd}=setup(`cumulative-${name}`,[]);
      const manager=SessionManager.inMemory(cwd,undefined,makeEntries().entries as any);
      manager.appendCompaction("Superseded checkpoint", "entry-0",100,{strategy:STRATEGY,modifiedFiles:["/tmp/superseded.js"]},true);
      manager.appendCompaction("Current checkpoint", "entry-2",100,details,true);
      manager.appendMessage({role:"user",content:"Continue current work.",timestamp:Date.now()});
      (ctx as any).sessionManager=manager;
      const event=beforeCompactEvent("entry-4");event.preparation.fileOps.read.add("/tmp/newly-edited.js");event.preparation.fileOps.edited.add("/tmp/newly-edited.js");
      const result:any=await fire(api,"session_before_compact",event,ctx);
      assert.deepEqual(result.compaction.details.readFiles,expectedReads);
      assert.deepEqual(result.compaction.details.modifiedFiles,expectedEdits);
      assert.ok(!result.compaction.summary.includes("/tmp/superseded.js"));
    });
  }
  test("disabled extension yields to native compaction",async()=>{
    const {api,ctx,cwd}=setup("disabled",[]);
    writeFileSync(join(cwd,".pi","settings.json"),JSON.stringify({betterCompaction:{enabled:false}}));
    assert.equal(await fire(api,"session_before_compact",beforeCompactEvent("entry-2"),ctx),undefined);
    assert.equal(ctx.calls.length,0);
  });
  test("honors Pi context edits when rebuilding the cached prefix",async()=>{
    const {api,ctx}=setup("context-edits",[]);
    const fixture=makeEntries();
    fixture.entries.push({type:"context_edit",id:"edit-1",parentId:fixture.leafId,timestamp:new Date().toISOString(),targetId:"entry-0",replacement:{content:"Corrected canonical user request."}});
    ctx.sessionManager.getEntries=()=>fixture.entries;
    ctx.sessionManager.getLeafId=()=>"edit-1";
    await fire(api,"session_before_compact",beforeCompactEvent("entry-2"),ctx);
    const context:any=ctx.calls[0][1];
    assert.ok(JSON.stringify(context).includes("Corrected canonical user request."));
    assert.ok(!JSON.stringify(context).includes("Read the codebase and tell me what it does."));
  });

  test("omits superseded checkpoints retained inside a later compaction range",async()=>{
    const {api,ctx}=setup("superseded-summary",[]);
    const entries:any[]=makeEntries().entries;
    const old={type:"compaction",id:"old-compaction",parentId:"entry-1",timestamp:new Date().toISOString(),summary:"SUPERSEDED_CHECKPOINT_MARKER",tokensBefore:100,firstKeptEntryId:"entry-0"};
    entries[2].parentId=old.id;
    const latest={type:"compaction",id:"new-compaction",parentId:"entry-3",timestamp:new Date().toISOString(),summary:"LATEST_CHECKPOINT_MARKER",tokensBefore:200,firstKeptEntryId:old.id};
    entries[4].parentId=latest.id;
    entries.splice(2,0,old);entries.splice(5,0,latest);
    ctx.sessionManager.getEntries=()=>entries;
    await fire(api,"session_before_compact",beforeCompactEvent("entry-4"),ctx);
    const context:any=ctx.calls[0][1];
    assert.ok(JSON.stringify(context).includes("LATEST_CHECKPOINT_MARKER"));
    assert.ok(!JSON.stringify(context).includes("SUPERSEDED_CHECKPOINT_MARKER"));
  });

  test("other providers continue excluding the retained tail",async()=>{
    const {api,ctx}=setup("other-provider",[]);ctx.model.provider="test";
    const result:any=await fire(api,"session_before_compact",beforeCompactEvent("entry-2"),ctx);
    assert.ok(!JSON.stringify(ctx.calls[0][1]).includes("Now add a config file option."));
    assert.equal(result.compaction.details.cacheStrategy,"prefix");
  });
  test("oversized full history yields to native without issuing an invalid request",async()=>{
    const {api,ctx,notices}=setup("oversized-full",[]);ctx.model.provider="splash";(ctx.model as any).contextWindow=131072;
    const event=beforeCompactEvent("entry-2");event.preparation.tokensBefore=130000;
    await primeCapture(api,ctx);
    assert.equal(await fire(api,"session_before_compact",event,ctx),undefined);
    assert.equal(ctx.calls.length,0);
    assert.deepEqual(notices,[],"Overflow must reach the captured budget guard, not a missing-capture fallback");
  });
  test("full history caps the response budget to remaining context",async()=>{
    const {api,ctx}=setup("budget-full",[]);ctx.model.provider="splash";(ctx.model as any).maxTokens=4096;(ctx.model as any).contextWindow=131072;
    await primeCapture(api,ctx);
    const result:any=await fire(api,"session_before_compact",beforeCompactEvent("entry-2"),ctx);
    assert.equal(result.compaction.details.cacheStrategy,"captured-request");
    assert.ok((ctx.calls[0][2] as any).maxTokens<=4096);
    assert.ok((ctx.calls[0][2] as any).maxTokens>=2048);
  });

  test("aborted dangling calls leave valid older dialogue intact",async()=>{
    const {api,ctx}=setup("dangling-full",[]);
    const entries:any[]=makeEntries().entries;
    entries[4].message={...entries[3].message,content:[{type:"toolCall",id:"unfinished",name:"read",arguments:{path:"/tmp/unfinished"}}],stopReason:"aborted"};
    ctx.sessionManager.getEntries=()=>entries;
    await fire(api,"session_before_compact",beforeCompactEvent("entry-4"),ctx);
    const context=JSON.stringify(ctx.calls[0][1]);
    assert.ok(!context.includes("unfinished"));
    assert.ok(context.includes("Done, added --config."));
    assert.ok(!context.includes("SUMMARY BOUNDARY"));
  });


});
