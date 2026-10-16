/**
 * rcompact — cache-aware context compaction for Pi; a maintained fork of
 * BetterCompaction (NotSoSeriouss/BetterCompaction, MIT). See LICENSE and README.
 * Local OpenAI summaries append an instruction to the exact FINAL normal request,
 * captured using Pi's public startup provider API after ordinary extension hooks.
 * Memory/context/payload rewrites and tool schemas survive without Pi patches.
 * Latest output/results remain verbatim in Pi's retained tail. Missing or unsafe
 * captures use native compaction. Other API formats use the older-prefix strategy.
 * /rcompact is the main command; /bc and betterCompaction settings are compatible.
 * Snapshots are session-local and never written to disk. Reports are not LLM context.
 */
import { readFileSync } from "node:fs";
import { summaryThinkingBudget, applySummaryThinking, summaryReasoningInstruction, summaryOutputLimit } from "./summary-thinking";
import { isSushiPrefillRefusal, freshSummaryPrefix, isThinkingOnlySummary, needsSummaryFormatRecovery, CHECKPOINT_HEADINGS, hasCheckpointHeadings } from "./summary-recovery";
import { registerNormalThinkingRecovery } from "./normal-thinking-recovery";
import { capturedActivation } from "./activation";
import { createRequestCapture, validateSnapshot, summaryPayload, supportsRequestCapture, filterFileMetadata } from "./request-snapshot";
import { STRATEGY, REPORT_ENTRY, REVIEW_ENTRY, READABLE_REPORT_ENTRIES, READABLE_STRATEGY_ALIASES } from "./identifiers";
import { writeFileAtomic } from "./atomic-write";
import { DEFAULT_CACHE_MISS_MIN_PROMPT_TOKENS, measureCacheOutcome, recordCacheOutcome, selectCachePath, type CachePolicy, type CacheState } from "./cache-outcome";
	import { createRecallArchive, renderHits, renderGenerations, searchRecall, journalScope, readJournalEntry, type JournalReader, type RecallGeneration, MAX_RECALL_LIMIT, type RecallArchive, type RecallQuery } from "./recall-archive";
	import {
		createReviewQueue,
		enqueueReview,
		resolveReview,
		takeResolved,
		unverifiedCheckpoints,
		describeReviews,
		defaultCodes,
		type ReviewQueue,
		type ReviewRecord,
	} from "./review-queue";
import { parseVerification, verificationPrompt, revisionPrompt, stripGeneratedFileMetadata } from "./summary-verification";
import { createCompactionTelemetry, providerMeasurements, errorCategory } from "./compaction-telemetry";
import { formatCompactionReport, measureCompactedContext, type CompactionReportData } from "./compaction-report";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildSessionProjection,
	CONFIG_DIR_NAME,
	convertToLlm,
	estimateTokens,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { contentText, normalizeContext, retryAssistantCall } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Prompts (verbatim from pi's built-in compaction, compaction.ts / utils.ts)
// ---------------------------------------------------------------------------

/**
 * The role instruction that the built-in compaction sends as its system
 * prompt. Here it becomes part of the appended user message at the end of
 * the conversation.
 */
const SUMMARY_ROLE = `
<system>
THIS IS NOT A USER MESSAGE: IGNORE WHATEVER YOU WERE DOING YOUR TASK HAS NOW CHANGED. YOU'RE NOT A CODING AGENT ANYMORE, YOU'RE NOW A COMPACTING AGENT.
I KNOW IT MIGHT SEEM THAT YOU WERE DOING SOMETHING ELSE BUT THE MESSAGGES BEFORE ARE JUST FOR CONTEXT, YOU ONLY SUMMARIZE. DON'T USE TOOLS, DON'T DO MORE THAN ONE TURN.
YOU WILL NOW ONLY MAKE THIS SUMMARY.

I WILL MAKE IT AS CLEAR AS POSSIBLE FOR YOU:
DON'T USE ANY TOOL
DON'T WRITE MORE THAN 1 SINGLE MESSAGE WITH THE ENTIRE SUMMARY IN IT
I DON'T CARE THAT WE WERE DOING SOMETHING ELSE
YOUR ONLY TASK IS TO DO THIS SUMMARY RIGHT NOW AND NOTHING ELSE
DO NOT ASK ME ANY OTHER QUESTIONS.
</system>

You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.
`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
Distinguish verified results from hypotheses. Preserve failed tests, unresolved issues, and exact reproduction steps.
Do not mark work completed without supporting evidence. Label diagnoses inferred by the assistant as hypotheses unless tool evidence verifies them. Preserve contradictions and unknown causes rather than resolving them by assumption. Honor later corrections over earlier guesses. Apply these evidence labels consistently in EVERY section, including Done, Key Decisions and Next Steps. An earlier checkpoint or repeated assistant assertion is not independent verification. Observing that one suspected cause is absent does not establish a different cause. If the conversation calls a cause both certain and unverified without a diagnostic that resolves the conflict, report the cause as unresolved. Separate observed symptoms, verified causes, attempted edits, failed edits and proposed next actions. Before output, check that no hypothesis becomes an established fact elsewhere in the summary. Preserve the scope of every test result: a focused script or selected checks do not establish the status or pass totals of a full suite. An earlier suite failure remains unresolved until that suite or its failed checks are reverified. Do not promote intended validation targets into measured results.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.
Distinguish verified results from hypotheses. Preserve failed tests, unresolved issues, and exact reproduction steps.
Do not mark work completed without supporting evidence. Label diagnoses inferred by the assistant as hypotheses unless tool evidence verifies them. Preserve contradictions and unknown causes rather than resolving them by assumption. Honor later corrections over earlier guesses. Apply these evidence labels consistently in EVERY section, including Done, Key Decisions and Next Steps. An earlier checkpoint or repeated assistant assertion is not independent verification. Observing that one suspected cause is absent does not establish a different cause. If the conversation calls a cause both certain and unverified without a diagnostic that resolves the conflict, report the cause as unresolved. Separate observed symptoms, verified causes, attempted edits, failed edits and proposed next actions. Before output, check that no hypothesis becomes an established fact elsewhere in the summary. Preserve the scope of every test result: a focused script or selected checks do not establish the status or pass totals of a full suite. An earlier suite failure remains unresolved until that suite or its failed checks are reverified. Do not promote intended validation targets into measured results.`;

// ---------------------------------------------------------------------------
// Helpers (same semantics as pi's compaction/utils.ts)
// ---------------------------------------------------------------------------

/** Same as pi's computeFileLists(): readFiles = read but not modified. */
function computeFileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles, modifiedFiles };
}

/** Same as pi's formatFileOperations(): XML sections appended to the summary. */
function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Low-thinking cap (OpenAI-compatible thinking-token budget)
// ---------------------------------------------------------------------------

/** Default cap on thinking tokens for "low" compaction (pi-ai's default "low" budget). */
const DEFAULT_LOW_THINKING_BUDGET = 2048;
/** Tokens always left for the summary itself under a shared response ceiling (pi-ai's MIN_ANSWER_TOKENS). */
const MIN_ANSWER_TOKENS = 1024;

/**
 * Top-level OpenAI-compatible request fields that backends read for a
 * reasoning-token cap — the same values as pi-ai's compat.thinkingTokenBudgetField:
 * "thinking_budget_tokens" (llama.cpp), "thinking_token_budget" (vLLM),
 * "thinking_budget" (Qwen/DashScope/SGLang).
 */
type ThinkingBudgetField = "thinking_budget" | "thinking_token_budget" | "thinking_budget_tokens";

/**
 * Which field carries the thinking cap. An explicit settings value wins;
 * "auto" (default) honors the model's compat.thinkingTokenBudgetField when
 * set, and otherwise falls back to the llama.cpp field (local llama.cpp is
 * the backend this extension targets).
 */
function resolveThinkingBudgetField(
	model: { compat?: unknown },
	configured?: "auto" | ThinkingBudgetField,
): ThinkingBudgetField {
	if (configured && configured !== "auto") return configured;
	const compatField = (model.compat as { thinkingTokenBudgetField?: string } | undefined)?.thinkingTokenBudgetField;
	if (
		compatField === "thinking_budget" ||
		compatField === "thinking_token_budget" ||
		compatField === "thinking_budget_tokens"
	) {
		return compatField;
	}
	return "thinking_budget_tokens";
}

// ---------------------------------------------------------------------------
// pi settings
//
// pi's agent applies several settings to every LLM request (image blocking,
// retry policy, provider timeout/transport, thinking budgets). The
// compaction request must mirror them to stay identical to the agent's own
// requests. Extensions have no settings API, so we read the same files pi's
// SettingsManager merges (global, then project; project wins).
// ---------------------------------------------------------------------------

interface PiSettings {
	images?: { blockImages?: boolean };
	retry?: {
		enabled?: boolean;
		maxRetries?: number;
		baseDelayMs?: number;
		maxAgentDelayMs?: number;
		provider?: {
			timeoutMs?: number;
			maxRetries?: number;
			maxRetryDelayMs?: number;
		};
	};
	httpIdleTimeoutMs?: number;
	websocketConnectTimeoutMs?: number;
	transport?: "sse" | "websocket" | "websocket-cached" | "auto";
	thinkingBudgets?: { minimal?: number; low?: number; medium?: number; high?: number };
	betterCompaction?: BetterCompactionSettings;
}

/** The betterCompaction section of pi's settings. */
interface BetterCompactionSettings {
	/** Sushi generation-only reasoning cap. null/unset inherits; normal session reasoning is unchanged. */
	sushiThinkingBudget?: number | null;
	sushiMaxTokens?: number | null;
	/** Encourage brief extraction while retaining evidence; only active with a valid Sushi summary budget. */
	sushiBriefReasoning?: boolean;
	/** Blocking validates before apply; background reviews at the next idle boundary. */
	verify?: boolean | "blocking" | "background" | "off";
	/** Explicit model-id or provider/model globs override the zero-cost heuristic. */
	models?: string[];
	/** One local Sushi thinking-only normal-turn recovery per user run. Defaults on. */
	normalThinkingRecovery?: boolean;
	/**
	 * What a measured prefix-cache miss does to the NEXT compaction. Default
	 * "defer-after-miss": hand one compaction back to native (or five after a
	 * three-miss streak) and re-probe afterwards. "keep" records misses without
	 * ever deferring; "native" never uses the captured-request ask on engines
	 * that would otherwise qualify. Does not affect the reconstructed-prefix
	 * path used by APIs we cannot capture. Unmeasured usage is never a miss.
	 */
	cachePolicy?: CachePolicy;
	/** Minimum prompt tokens for a zero-cache-read ask to count as a miss. */
	cacheMissMinPromptTokens?: number;
	/**
	 * Register the recall tools over the transcript that compaction replaced.
	 * Default off: a tool declaration is sent on EVERY ordinary request, so
	 * enabling this trades tokens on all future turns for post-compaction recall.
	 * Read at session start only — turning it on needs `/reload`, because adding
	 * a tool mid-session makes Pi append a tool-change checkpoint, which costs a
	 * full transcript re-render on providers that cannot represent the transition.
	 */
	recall?: boolean;
	recallMaxGenerations?: number;
	recallMaxBytes?: number;
	/**
	 * Where recall reads from. "archive" (default) searches the filtered request
	 * view of compactions done by THIS process, so anything a redaction or
	 * pruning hook withheld stays withheld. "stored" additionally reads Pi's
	 * session journal for the full pre-compaction branch: maximum reach, and it
	 * can surface text a hook removed from a request, so every such result is
	 * labelled UNFILTERED. Read-only; recall never rewrites stored history.
	 */
	recallJournal?: "archive" | "stored";
	enabled?: boolean;
	/** Show the "Compaction completed in Xs ..." message after compaction. */
	report?: boolean;
	/** Thinking level for the summarization call. */
	thinking?: "low" | "off" | "inherit";
	/**
	 * Max thinking tokens for the summarization call when its effective
	 * thinking level is "low". Sent as a top-level OpenAI-compatible request
	 * field (see thinkingBudgetField) via samplingParams, so backends such as
	 * llama.cpp cap the thinking phase. Falls back to the global
	 * thinkingBudgets.low, then DEFAULT_LOW_THINKING_BUDGET. 0 disables the cap.
	 */
	lowThinkingBudget?: number;
	/**
	 * Top-level request field carrying the thinking cap (same values as
	 * pi-ai's compat.thinkingTokenBudgetField). "auto" (default) honors the
	 * model's compat setting when set, otherwise uses the llama.cpp field.
	 * Only OpenAI-compatible backends apply the cap; other APIs ignore it.
	 */
	thinkingBudgetField?: "auto" | "thinking_budget" | "thinking_token_budget" | "thinking_budget_tokens";
}

/** One-line cache feedback for /rcompact: policy plus the live per-session streak. */
/** One-line recall state for `/rcompact`. */
function formatRecallState(archive: RecallArchive | undefined, mode: "archive" | "stored" = "archive"): string {
	if (!archive) return "recall: off (betterCompaction.recall; /reload after enabling)";
	// The mode belongs in the status line: stored-journal results are unfiltered,
	// and a reader looking only at counts cannot tell which guarantee is active.
	const source = mode === "stored" ? ", source: UNFILTERED session journal" : ", source: filtered request view";
	const stats = archive.describe();
	return `recall: on${source} (${stats.generations} archived checkpoint${stats.generations === 1 ? "" : "s"}, ${stats.messages} messages, ${Math.round(stats.bytes / 1024)} KiB)`;
}

function formatCachePolicy(policy: CachePolicy | undefined, state: CacheState | undefined): string {
	return (
		`cache policy: ${policy ?? "defer-after-miss"}` +
		(state ? ` (misses ${state.misses}, deferred ${state.deferredFor})` : " (no measured compaction this session)")
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Same deep-merge semantics as pi's SettingsManager (override wins). */
function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		out[key] = isObject(out[key]) && isObject(value) ? mergeSettings(out[key], value) : value;
	}
	return out;
}

function readSettingsFile(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function globalSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

interface PiSettingsSource {
	settings: PiSettings;
	/** Which file currently provides the effective betterCompaction config. */
	betterCompactionSource: "global" | "project";
	betterCompactionSourcePath: string;
}

/** Read pi's global + project settings the same way SettingsManager does. */
function loadPiSettings(cwd: string): PiSettingsSource {
	const globalSettings = readSettingsFile(globalSettingsPath());
	const projectSettings = readSettingsFile(projectSettingsPath(cwd));
	const fromProject = "betterCompaction" in projectSettings;
	return {
		settings: mergeSettings(globalSettings, projectSettings) as PiSettings,
		betterCompactionSource: fromProject ? "project" : "global",
		betterCompactionSourcePath: fromProject ? projectSettingsPath(cwd) : globalSettingsPath(),
	};
}

/**
 * Effective max thinking tokens for the summarization call at thinking level
 * "low", or 0 for no cap. betterCompaction.lowThinkingBudget wins (including
 * an explicit 0), then the global thinkingBudgets.low, then the default.
 */
function lowThinkingCap(settings: PiSettings): number {
	const budget =
		settings.betterCompaction?.lowThinkingBudget ?? settings.thinkingBudgets?.low ?? DEFAULT_LOW_THINKING_BUDGET;
	return typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
}

/**
 * Update the betterCompaction section in the settings file that currently
 * provides it (project wins over global), so /bc always edits the file that
 * is actually in effect. Returns the path written.
 */
function writeBetterCompactionSetting(cwd: string, patch: Partial<BetterCompactionSettings>): string {
	const { betterCompactionSourcePath } = loadPiSettings(cwd);
	const current = readSettingsFile(betterCompactionSourcePath);
	const section = isObject(current.betterCompaction) ? { ...current.betterCompaction } : {};
	Object.assign(section, patch);
	current.betterCompaction = section;
	// Staged write + rename with a .bak, so an interrupted save can never leave a
	// truncated settings.json behind (see atomic-write.ts).
	writeFileAtomic(betterCompactionSourcePath, JSON.stringify(current, null, 2) + "\n");
	return betterCompactionSourcePath;
}

type LlmMessage = ReturnType<typeof convertToLlm>[number];

const IMAGE_BLOCKED_PLACEHOLDER = "Image reading is disabled.";

/**
 * Same as pi's convertToLlmWithBlockImages filter (sdk.ts): when
 * images.blockImages is enabled, the agent's requests replace image blocks
 * with a text placeholder. Apply the identical filter so the rebuilt prefix
 * matches what the agent actually sent to the LLM.
 */
function applyBlockImages(messages: LlmMessage[]): LlmMessage[] {
	return messages.map((msg) => {
		if (msg.role !== "user" && msg.role !== "toolResult") return msg;
		const content = msg.content;
		if (typeof content === "string" || !content.some((c) => c.type === "image")) return msg;
		const filtered = content
			.map((c) => (c.type === "image" ? { type: "text" as const, text: IMAGE_BLOCKED_PLACEHOLDER } : c))
			.filter(
				(c, i, arr) =>
					!(
						c.type === "text" &&
						c.text === IMAGE_BLOCKED_PLACEHOLDER &&
						i > 0 &&
						arr[i - 1].type === "text" &&
						(arr[i - 1] as { text?: string }).text === IMAGE_BLOCKED_PLACEHOLDER
					),
			);
		return { ...msg, content: filtered } as LlmMessage;
	});
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Timing/cache metadata for the post-compaction report. Stored during the
 * summarization step (session_before_compact) and consumed by the
 * session_compact event, which pi fires only after the compaction result has
 * been applied. Keyed by session id so concurrent sessions don't interfere.
 */
interface CompactionReport {
	/** Wall-clock time of the final summarization attempt, ms. */
	totalMs: number;
	/** First thinking token → start of the answer, ms (see produce() below). */
	thinkingMs: number;
	/** Tokens served from the prefix cache on the final attempt. */
	cacheRead: number;
	promptTokens?: number;
	tokensBefore?: number;
	verificationStatus?: string;
}

interface DetachedReviewOutcome {
	valid: boolean;
	issues: string[];
	replacement?: string;
	passes: number;
	revisions?: number;
	verificationMs: number;
	revisionMs: number;
}

interface DetachedReviewJob {
	controller: AbortController;
	queue: ReviewQueue;
	checkpointKey: string;
	startedAt: number;
	telemetry?: { update: (data: Record<string, unknown>) => void };
	run: () => Promise<DetachedReviewOutcome>;
}

/** Durable, user-visible record of a failed detached evidence review. */
export interface CompactionReviewData {
	checkpointId: string;
	piCheckpointId?: string;
	state: string;
	codes: string[];
	issues: string[];
	askedAfterMs: number;
	replacement?: string;
	timestamp: number;
}

/** One-line summary of the detached review queue for /rcompact. */
export function formatReviewState(queue: ReviewQueue | undefined, disabled: boolean): string {
	if (disabled || !queue) return "off";
	const stats = describeReviews(queue);
	if (stats.pending > 0) return `detached, ${stats.pending} awaiting an idle boundary`;
	if (stats.rejected + stats.expired > 0) return `${stats.rejected + stats.expired} rejected checkpoint(s), still in context`;
	return stats.passed > 0 ? "detached, verified" : "detached, none pending";
}

function reviewMode(settings: BetterCompactionSettings | undefined): "off" | "blocking" | "background" {
	return settings?.verify === false || settings?.verify === "off" ? "off" : settings?.verify === "background" ? "background" : "blocking";
}

export default function (pi: ExtensionAPI) {
	const requestCapture = createRequestCapture(pi);
	registerNormalThinkingRecovery(pi, cwd => loadPiSettings(cwd).settings.betterCompaction ?? {});
	pi.on("session_compact", () => requestCapture.resume());
	pi.on("session_compact_failed", () => requestCapture.resume());
	const fallbackWarnings = new Set<string>();
	pi.on("session_start", () => fallbackWarnings.clear());
	// Reports stashed by the session_before_compact handler, emitted on
	// session_compact (see below). Cleared on session_compact_failed.
	const pendingReports = new Map<string, CompactionReport>();
	const attempts = new Map<string, ReturnType<typeof createCompactionTelemetry>>();
	// Per-session measured prefix-cache streak. In memory only: a reload or an
	// engine restart legitimately changes cache residency, so the next captured
	// compaction re-measures rather than trusting a stale miss.
	const cacheStates = new Map<string, CacheState>();
	// Detached evidence review (1.2.6). Keyed by session id: one review in
	// flight per session, so a busy session cannot pile up asks.
	const reviewQueues = new Map<string, ReviewQueue>();
	const detachedJobs = new Map<string, DetachedReviewJob>();
	const runningReviews = new Set<DetachedReviewJob>();
	let reviewEpoch = 0;

	function reviewQueueFor(sessionId: string): ReviewQueue {
		let queue = reviewQueues.get(sessionId);
		if (!queue) {
			queue = createReviewQueue();
			reviewQueues.set(sessionId, queue);
		}
		return queue;
	}

	/**
	 * Loud rejection. An applied checkpoint cannot be un-applied on Pi 1.1.0:
	 * `appendContextEdit` refuses compaction entries, and rewinding the leaf would
	 * abandon the turns the user took after the checkpoint. So the consequence of a
	 * failed review is visibility, not a silent fix: warn the user, persist the
	 * verdict in the session, and tell the model in the next summary ask.
	 */
	function announceFailedReview(record: ReviewRecord, replacement: string | undefined, ctx: ExtensionContext): void {
		const stale = record.state === "expired";
		const firstIssue = record.issueText?.split("\n").filter(Boolean)[0] ?? "no details";
		ctx.ui.notify(
			`rcompact: checkpoint ${record.piCheckpointId ?? record.checkpointId} ${stale ? "aged out of its evidence review" : "FAILED its evidence review"}. ` +
				`It is still in your context and is NOT verified. ${firstIssue}`,
			"warning",
		);
		pi.appendEntry<CompactionReviewData>(REVIEW_ENTRY, {
			checkpointId: record.checkpointId,
			...(record.piCheckpointId ? { piCheckpointId: record.piCheckpointId } : {}),
			state: record.state,
			codes: record.issueCodes ?? [],
			issues: record.issueText ? record.issueText.split("\n").filter(Boolean) : [],
			askedAfterMs: (record.resolvedAt ?? Date.now()) - record.enqueuedAt,
			...(replacement ? { replacement } : {}),
			timestamp: Date.now(),
		});
	}

	/** Run the review scheduled for this session, if any. Called at idle boundaries. */
	async function drainDetachedReview(ctx: ExtensionContext): Promise<void> {
		const sessionId = ctx.sessionManager.getSessionId();
		const job = detachedJobs.get(sessionId);
		if (!job) return;
		detachedJobs.delete(sessionId);
		runningReviews.add(job);
		const epoch = reviewEpoch;
		let outcome: DetachedReviewOutcome;
		try {
			outcome = await job.run();
		} catch (error) {
			// A review that cannot run is not a pass: the checkpoint stays unverified.
			outcome = {
				valid: false,
				issues: [`Evidence review could not run: ${error instanceof Error ? error.message : String(error)}`],
				passes: 0,
				verificationMs: 0,
				revisionMs: 0,
			};
		}
		runningReviews.delete(job);
		// Reload/session changes retire the closure. A late verdict must never write
		// to whichever session the host has switched to in the meantime.
		if (epoch !== reviewEpoch || ctx.sessionManager.getSessionId() !== sessionId ||
			!ctx.sessionManager.getBranch().some((entry: any) => entry.id === job.queue.records.get(job.checkpointKey)?.piCheckpointId)) {
			job.telemetry?.update({verificationStatus:"expired",reviewDetached:true});
			return;
		}
		const record = resolveReview(job.queue, job.checkpointKey, { valid: outcome.valid, issues: outcome.issues });
		job.telemetry?.update({
			verificationStatus: record?.state === "expired" ? "expired" : outcome.valid ? "passed" : "rejected",
			verificationPasses: outcome.passes,
			verificationMs: outcome.verificationMs,
			reviewDetached: true,
			...(outcome.revisions ? { revisions: outcome.revisions, revisionMs: outcome.revisionMs } : {}),
			...(!outcome.valid ? { reviewIssues: record?.issueCodes ?? defaultCodes(outcome.issues) } : {}),
		});
		if (!record) return;
		for (const ready of takeResolved(job.queue)) {
			if (ready.state === "rejected" || ready.state === "expired") announceFailedReview(ready, outcome.replacement, ctx);
		}
	}

	pi.on("session_start", () => pendingReports.clear());
	pi.on("session_start", () => cacheStates.clear());
	pi.on("session_start", () => {
		reviewEpoch++;
		for (const job of [...detachedJobs.values(), ...runningReviews]) job.controller.abort();
		reviewQueues.clear(); detachedJobs.clear();
	});
	pi.on("session_shutdown", () => pendingReports.clear());
	pi.on("session_shutdown", () => cacheStates.clear());
	pi.on("session_shutdown", () => {
		reviewEpoch++;
		for (const job of detachedJobs.values()) job.telemetry?.update({verificationStatus:"pending",reviewAbandoned:true});
		for (const job of [...detachedJobs.values(), ...runningReviews]) job.controller.abort();
		reviewQueues.clear(); detachedJobs.clear();
	});

	// Recall over the context that compaction replaced. Opt-in, because a tool
	// declaration is sent on EVERY ordinary request: enabling it trades tokens on
	// all future turns for the ability to re-read what a checkpoint summarized
	// away. It is registered at extension load only — adding a tool mid-session
	// makes Pi append a tool-change checkpoint, which invalidates the cached
	// prefix on providers that cannot represent the transition. The archive holds
	// the FILTERED request view, never Pi's stored entries, so text that a
	// redaction or pruning hook removed cannot be resurrected by recall. In
	// memory only, byte-capped, and dropped on reload like the snapshots are.
	let recallArchive: RecallArchive | undefined;
	let recallToolsRegistered = false;

	// Fallback bindings for recall. Captured from session_start when the host emits
	// it; the tools also resolve mode and manager at call time because Pi does NOT
	// re-emit session_start on reload (verified in the SDK harness: no session_start
	// at bind, after prompt, or after two reloads), so handler-only state goes stale
	// whenever the user switches recallJournal and runs /reload.
	let recallJournalManager: JournalReader | undefined;
	let recallJournalMode: "archive" | "stored" = "archive";

	/** Effective recall source: live settings, then the session_start fallback. */
	function resolveRecallSource(toolCtx?: any): { mode: "archive" | "stored"; manager?: JournalReader } {
		let mode: "archive" | "stored" = recallJournalMode;
		try {
			const { settings } = loadPiSettings(toolCtx?.cwd ?? process.cwd());
			mode = settings.betterCompaction?.recallJournal === "stored" ? "stored" : "archive";
		} catch {
			// Unparseable settings: keep the last known mode rather than guessing.
		}
		const manager = (toolCtx?.sessionManager as JournalReader | undefined) ?? recallJournalManager;
		return { mode, manager };
	}

	const ensureRecallArchive = (loaded: any) => {
		recallArchive = createRecallArchive({
			maxGenerations: loaded?.betterCompaction?.recallMaxGenerations,
			maxBytes: loaded?.betterCompaction?.recallMaxBytes,
		});
	};

	const registerRecallTools = () => {
		if (recallToolsRegistered) return;
	pi.registerTool({
		name: "recall_before_compaction",
		label: "Recall pre-compaction transcript",
		description:
			"Search the transcript that rcompact summarized away. Context before the last checkpoint is no longer visible to the model; this reads the exact filtered request view of it, newest checkpoint first. Use it for verbatim quotes, exact error text, file contents, and numbers a summary dropped.",
		promptSnippet: "Search transcript replaced by compaction",
		promptGuidelines: [
			"When the answer needs verbatim text from before a compaction checkpoint, call recall_before_compaction instead of guessing from the summary.",
		],
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Literal text to find (case-insensitive unless caseSensitive)." },
				patterns: {
					type: "array",
					items: { type: "string" },
					description: `Up to 12 literal or regex alternatives, matched as OR (max ${MAX_RECALL_LIMIT} hits total).`,
				},
				isRegex: { type: "boolean", description: "Treat pattern/patterns as regular expressions. Default false." },
				caseSensitive: { type: "boolean", description: "Case-sensitive matching. Default false." },
				roles: {
					type: "array",
					items: { type: "string", enum: ["user", "assistant", "system", "toolResult", "tool_use", "tool_result"] },
					description: "Only search messages with these roles.",
				},
				toolNames: { type: "array", items: { type: "string" }, description: "Only messages that called one of these tools." },
				fromGeneration: { type: "integer", description: "Only this generation and newer (see recall_generations)." },
				entryId: { type: "string", description: "Read one stored journal entry by id instead of searching (needs betterCompaction.recallJournal: stored)." },
				offsetChars: { type: "integer", minimum: 0, description: "Character offset into the entry text for an entryId read." },
				maxChars: { type: "integer", minimum: 20, maximum: 20000, description: "Maximum characters for an entryId read. Default 4000." },
				limit: { type: "integer", minimum: 1, maximum: MAX_RECALL_LIMIT, description: "Maximum hits. Default 12." },
				snippetChars: { type: "integer", minimum: 80, maximum: 4000, description: "Characters of text per hit. Default 700." },
			},
			additionalProperties: false,
		},
		async execute(_toolCallId, params, _signal, _onUpdate, toolCtx) {
			const query = (params ?? {}) as RecallQuery & { entryId?: string; offsetChars?: number; maxChars?: number };
			const source = resolveRecallSource(toolCtx);
			const manager = source.manager;
			const state = (extra: Record<string, unknown> = {}) => ({
				content: [{ type: "text" as const, text: String(extra.text ?? "") }],
				details: {
					result: String(extra.result ?? ""),
					source: String(extra.source ?? (source.mode === "stored" ? "stored-journal" : "filtered-archive")),
					hits: Number(extra.hits ?? 0),
					generations: recallArchive?.describe().generations ?? 0,
					messages: recallArchive?.describe().messages ?? 0,
					bytes: recallArchive?.describe().bytes ?? 0,
				},
			});
			// entryId reads one stored entry by id, paged by characters. Read-only:
			// recall never rewrites or branches stored history.
			if (query.entryId) {
				if (source.mode !== "stored") return state({text:"Entry reads require explicit recallJournal: stored (UNFILTERED).",result:"raw-mode-disabled"});
				if (!manager) return state({ text: "No session journal is bound to this recall tool.", result: "no-journal" });
				const read = readJournalEntry(manager, query.entryId, query.offsetChars ?? 0, query.maxChars ?? 4000);
				if (!read) return state({ text: `No stored entry with id ${query.entryId}.`, result: "unknown-entry" });
				const start = Math.max(0, query.offsetChars ?? 0);
				const shown = read.text.length;
				const more = start + shown < read.totalChars;
				return state({
					text: `UNFILTERED stored journal\n[entry ${query.entryId} chars ${start}-${start + shown} of ${read.totalChars}${read.opaque ? ` opaque=${read.opaque.join(",")}` : ""}${more ? " (more: pass a larger offsetChars)" : ""}]\n${read.text}`,
					result: "entry",
					source: "stored-journal",
				});
			}
			if (!recallArchive) return state({ text: "Recall archive is not active for this session.", result: "inactive" });
			// Stored mode reads the whole pre-compaction branch from disk - that reach
			// beyond this process is the point of the opt-in - and labels results
			// UNFILTERED, because the journal keeps original text and can therefore show
			// what a redaction or pruning hook withheld from the model. Search bounds
			// (limit, snippetChars) still apply so recall cannot re-inflate context.
			if (source.mode === "stored" && manager) {
				const scope = journalScope(manager);
				if (scope.messages.length === 0) {
					return state({
						text: `The stored journal has no recallable text before the compaction boundary${scope.boundaryId ? ` ${scope.boundaryId}` : ""}.`,
						result: "empty-journal",
						source: "stored-journal",
					});
				}
				const generation: RecallGeneration = {
					id: 0,
					reason: "stored-journal",
					capturedAt: Date.now(),
					messages: scope.messages,
					bytes: Buffer.byteLength(JSON.stringify(scope.messages)),
				};
				let journalError: string | undefined;
				const hits = searchRecall([generation], query, undefined, (message) => {
					journalError = message;
				});
				if (journalError) return state({ text: journalError, result: "invalid-pattern" });
				return state({ text: renderHits(hits, true), result: "hits", hits: hits.length, source: "stored-journal" });
			}
			let patternError: string | undefined;
			const hits = searchRecall(recallArchive.generations, query, undefined, (message) => {
				patternError = message;
			});
			if (patternError) return state({ text: patternError, result: "invalid-pattern" });
			if (hits.length === 0 && !query.pattern && !query.patterns) {
				return state({
					text: "Provide pattern or patterns to search the archived transcript.",
					result: "no-pattern",
				});
			}
			return state({ text: renderHits(hits), result: "hits", hits: hits.length });
		},
	});
	pi.registerTool({
		name: "recall_generations",
		label: "List archived checkpoints",
		description:
			"List the compaction checkpoints whose transcript is recallable, with the archived message count, size, and reason for each. Call this before recall_before_compaction to know what exists.",
		promptSnippet: "List recallable pre-compaction checkpoints",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute(_toolCallId, _params, _signal, _onUpdate, toolCtx) {
			const archive = recallArchive;
			if (!archive) {
				return { content: [{ type: "text" as const, text: "Recall archive is not active for this session." }], details: { result: "inactive", hits: 0, generations: 0, messages: 0, bytes: 0 } };
			}
			const stats = archive.describe();
			const source = resolveRecallSource(toolCtx);
			const manager = source.manager;
			let modeLine = `\nmode=${source.mode}: results come from the filtered request view.`;
			if (source.mode === "stored" && manager) {
				const scope = journalScope(manager);
				modeLine = `\nmode=stored-journal (UNFILTERED): ${scope.messages.length} recallable messages before boundary ${scope.boundaryId ?? "none"}; ${scope.skipped.length} non-text entries reported as such.`;
			}
			return {
				content: [{ type: "text" as const, text: renderGenerations(archive.generations) + modeLine }],
				details: { result: "generations", hits: stats.ids.length, generations: stats.generations, messages: stats.messages, bytes: stats.bytes },
			};
		},
	});
		recallToolsRegistered = true;
	};

	// Pi builds its tool runtime from what the extension registered while it was
	// loading. Some SDK hosts do not emit `session_start` on reload, so an
	// opt-in tool registered only there never reaches the request. Reading the
	// settings synchronously at load is what makes `betterCompaction.recall` +
	// `/reload` work, and when the setting is off this block registers nothing.
	try {
		const boot = loadPiSettings(process.cwd());
		if (boot.settings?.betterCompaction?.recall) {
			ensureRecallArchive(boot.settings);
			registerRecallTools();
		}
	} catch {
		// A settings file Pi itself cannot parse must not break extension load:
		// compaction re-reads settings per attempt and falls back to native.
	}

	pi.on("session_start", (_event, ctx) => {
		const { settings } = loadPiSettings(ctx.cwd);
		if (!settings.betterCompaction?.recall) return;
		// Fresh archive per session start: the archive lives in memory, so a reload
		// or a new session legitimately discards the previous checkpoint.
		ensureRecallArchive(settings);
		recallJournalManager = ctx.sessionManager as unknown as JournalReader;
		recallJournalMode = settings.betterCompaction?.recallJournal === "stored" ? "stored" : "archive";
		registerRecallTools();
	});

	// Render the persisted post-compaction report in the chat. Custom entries
	// never participate in LLM context, so the report stays visible in the
	// transcript without being sent to the model. Reports written under earlier
	// names still render (see READABLE_REPORT_ENTRIES).
	for (const entryType of READABLE_REPORT_ENTRIES) {
		pi.registerEntryRenderer<CompactionReportData>(entryType, (entry, _options, theme) => {
			const data = entry.data;
			if (!data || typeof data.totalMs !== "number") return undefined;
			return new Text(theme.fg("dim", formatCompactionReport(data)), 0, 0);
		});
	}

	pi.registerEntryRenderer<CompactionReviewData>(REVIEW_ENTRY, (entry, _options, theme) => {
		const data = entry.data;
		if (!data || typeof data.checkpointId !== "string") return undefined;
		const head = data.state === "expired"
			? `rcompact: checkpoint ${data.piCheckpointId ?? data.checkpointId} aged out of its evidence review (unverified)`
			: `rcompact: checkpoint ${data.piCheckpointId ?? data.checkpointId} FAILED its evidence review`;
		const lines = [theme.fg(data.state === "rejected" ? "warning" : "dim", head)];
		for (const issue of (data.issues ?? []).slice(0, 6)) lines.push(theme.fg("dim", `  ${issue}`));
		if ((data.issues?.length ?? 0) > 6) lines.push(theme.fg("dim", `  … +${data.issues.length - 6} more`));
		lines.push(theme.fg("dim", data.replacement
			? "  A corrected summary was generated but NOT applied (Pi cannot replace an applied checkpoint). Run /compact to regenerate."
			: "  The applied checkpoint stays in context; verify its claims before relying on them."));
		return new Text(lines.join("\n"), 0, 0);
	});

	// A review only starts at an idle boundary: issuing a detached ask in the middle
	// of the user's next request would pause request-snapshot capture for that
	// request and silently cost the cache-friendly path on the next compaction.
	pi.on("agent_end", async (_event, ctx) => { await drainDetachedReview(ctx); });
	pi.on("before_agent_start", (event, ctx) => {
		// Durable rejections survive reload. Notify the NEXT ordinary model turn,
		// not just a later compaction, using only checkpoint ids (no reviewer prose).
		const branch: any[] = ctx.sessionManager.getBranch();
		const latest = [...branch].reverse().find((entry: any) => entry.type === "compaction");
		const rejected = [...branch].reverse().find((entry: any) => entry.type === "custom" && entry.customType === REVIEW_ENTRY && entry.data?.piCheckpointId === latest?.id);
		if (rejected && ["rejected","expired"].includes(rejected.data.state)) {
			return {systemPrompt:event.systemPrompt+`\nThe active checkpoint ${latest!.id} failed or expired evidence review. Treat its claims as unverified; check original evidence before acting. Use recall tools if enabled.`};
		}
	});

	// Warn once per session when compaction will run without thinking.
	pi.on("session_start", (_event, ctx) => {
		const { settings } = loadPiSettings(ctx.cwd);
		if (settings.betterCompaction?.enabled === false) return;
		const thinking = settings.betterCompaction?.thinking ?? "low";
		const noThinking =
			thinking === "off" || (thinking === "inherit" && (!ctx.thinkingLevel || ctx.thinkingLevel === "off"));
		if (noThinking && ctx.hasUI) {
			ctx.ui.notify(
				"rcompact: thinking is disabled for compaction — some models summarize significantly worse (or not at all) without it",
				"warning",
			);
		}
	});

	// /bc — inspect and control this extension's options.
	const compactionCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
		description:
			"rcompact: /rcompact [on|off|thinking low|off|inherit|lowbudget <tokens>|sushibudget inherit|<tokens>|report on|off|verify blocking|background|off|turnrecovery on|off|models auto|<glob>|recall on|off|archive|stored|cachepolicy defer|keep|native|check] — show or change compaction options",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "thinking", "lowbudget", "sushibudget", "report", "verify", "cachepolicy", "models", "recall", "turnrecovery", "check"];
			const filtered = options.filter((o) => o.startsWith(prefix.toLowerCase()));
			return filtered.length > 0
				? filtered.map((o) => ({ value: o, label: o, description: "rcompact option" }))
				: null;
		},
		handler: async (args, ctx) => {
			const { settings, betterCompactionSource, betterCompactionSourcePath } = loadPiSettings(ctx.cwd);
			const section: BetterCompactionSettings = settings.betterCompaction ?? {};
			const enabled = section.enabled !== false;
			const report = section.report !== false;
			const thinking = section.thinking ?? "low";
		const arg = args.trim().toLowerCase();
		if (arg === "turnrecovery" || arg.startsWith("turnrecovery ")) {
			const value = arg.split(/\s+/)[1];
			if (!["on", "off"].includes(value)) { ctx.ui.notify("Usage: /rcompact turnrecovery on|off", "error"); return; }
			const path = writeBetterCompactionSetting(ctx.cwd, {normalThinkingRecovery:value === "on"});
			ctx.ui.notify(`Sushi thinking-only turn recovery ${value} (${path}); applies to the next turn`);
			return;
		}
		if (arg === "models" || arg.startsWith("models ")) {
			const values = args.trim().split(/\s+/).slice(1);
			if (!values.length) { ctx.ui.notify("Usage: /rcompact models auto|<glob> [<glob>...]", "error"); return; }
			const path = writeBetterCompactionSetting(ctx.cwd, {models:values.length===1 && values[0]==="auto" ? undefined : values});
			ctx.ui.notify(`rcompact: model activation updated (${path}); applies at next compaction`);
			return;
		}
            if (arg === "check") {
                const result = await pi.exec(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "compatibility-check.mjs")], {timeout: 60000});
                ctx.ui.notify(result.code === 0 ? result.stdout.trim() : "rcompact compatibility check failed. " + result.stderr.slice(-1200), result.code === 0 ? "info" : "error");
                return;
            }

			if (arg === "") {
				const cap = lowThinkingCap(settings);
				const capInfo =
					cap > 0
						? ` | low thinking cap: ${cap} (${resolveThinkingBudgetField(ctx.model ?? {}, section.thinkingBudgetField)})`
						: "";
				ctx.ui.notify(
					`rcompact: ${enabled ? "enabled" : "disabled"} | compaction thinking: ${thinking} | ` +
						`report: ${report ? "on" : "off"} | evidence review: ${reviewMode(section)}${reviewMode(section)==="background"?" ("+formatReviewState(reviewQueueFor(ctx.sessionManager.getSessionId()),false)+")":""} | session thinking: ${ctx.thinkingLevel ?? "off"}${capInfo} | Sushi summary budget: ${section.sushiThinkingBudget ?? "inherit"} | Sushi summary output: ${section.sushiMaxTokens ?? "inherit"} | focused extraction: ${section.sushiBriefReasoning === true && summaryThinkingBudget(ctx.model, section.sushiThinkingBudget, ctx.model?.maxTokens ?? 0) !== undefined ? "on" : "off"} | ` +
						`thinking-only turn recovery: ${section.normalThinkingRecovery === false ? "off" : "on (one per run)"} | models: ${section.models?.join(", ") ?? "auto (zero input/cache cost)"} | ${formatCachePolicy(section.cachePolicy, cacheStates.get(ctx.sessionManager.getSessionId()))} | ${formatRecallState(recallArchive, section.recallJournal === "stored" ? "stored" : "archive")} | request snapshot: ${requestCapture.get() ? "ready" : "waiting for ordinary request"} | config: ${betterCompactionSource} (${betterCompactionSourcePath})`,
				);
				return;
			}
			if (arg === "on" || arg === "off") {
				const path = writeBetterCompactionSetting(ctx.cwd, { enabled: arg === "on" });
				ctx.ui.notify(
					`rcompact ${arg === "on" ? "enabled" : "disabled"} (written to ${path}; ` +
						`applies at the next compaction)`,
				);
				return;
			}
			if (arg.startsWith("thinking")) {
				const value = arg.split(/\s+/)[1];
				if (value !== "low" && value !== "off" && value !== "inherit") {
					ctx.ui.notify("rcompact: usage: /rcompact thinking low|off|inherit", "error");
					return;
				}
				const path = writeBetterCompactionSetting(ctx.cwd, { thinking: value });
				ctx.ui.notify(
					`rcompact: compaction thinking set to ${value} (written to ${path}; ` +
						`applies at the next compaction)`,
				);
				return;
			}
			if (arg.split(/\s+/)[0] === "sushibudget") {
				const parts = arg.split(/\s+/);
				const raw = parts[1];
				const value = raw === "inherit" ? null : raw === undefined ? NaN : Number(raw);
				if (parts.length !== 2 || (value !== null && (!Number.isSafeInteger(value) || value < 0))) {
					ctx.ui.notify("rcompact: usage: /rcompact sushibudget inherit|<tokens> (0 = no thinking)", "error");
					return;
				}
				const path = writeBetterCompactionSetting(ctx.cwd, { sushiThinkingBudget: value });
				ctx.ui.notify(`rcompact: Sushi summary budget ${value ?? "inherit"} (written to ${path}; applies at the next compaction; session thinking unchanged)`);
				return;
			}
			if (arg.startsWith("lowbudget")) {
				const raw = arg.split(/\s+/)[1];
				const value = raw === undefined ? Number.NaN : Number(raw);
				if (!Number.isInteger(value) || value < 0) {
					ctx.ui.notify("rcompact: usage: /rcompact lowbudget <tokens> (0 = no cap)", "error");
					return;
				}
				const path = writeBetterCompactionSetting(ctx.cwd, { lowThinkingBudget: value });
				ctx.ui.notify(
					`rcompact: low-thinking cap set to ${value === 0 ? "off" : `${value} tokens`} ` +
						`(written to ${path}; applies at the next compaction)`,
				);
				return;
			}
			if (arg.startsWith("verify")) {
				const value=arg.split(/\s+/)[1];
				if(!["on","off","background","blocking"].includes(value)){ctx.ui.notify("rcompact: usage: /rcompact verify blocking|background|off","error");return;}
				const path=writeBetterCompactionSetting(ctx.cwd,{verify:value==="on"?"blocking":value as "off"|"background"|"blocking"});
				ctx.ui.notify(`rcompact: evidence review ${value} (written to ${path}; applies at the next compaction)`);return;
			}
			if (arg.startsWith("recall")) {
				const value = arg.split(/\s+/)[1];
				// on|off gates the tools; archive|stored picks where they read from and implies on.
				const modes: Record<string, "archive" | "stored"> = { archive: "archive", stored: "stored" };
				if (value !== "on" && value !== "off" && !modes[value]) {
					ctx.ui.notify("rcompact: usage: /rcompact recall on|off|archive|stored", "error");
					return;
				}
				const patch = modes[value]
					? { recall: true as const, recallJournal: modes[value] }
					: { recall: value === "on" as const };
				const path = writeBetterCompactionSetting(ctx.cwd, patch);
				const suffix = !modes[value]
					? ""
					: value === "stored"
						? " reading Pi’s session journal, which holds ORIGINAL text: results are labelled UNFILTERED and can show what a redaction hook withheld from the model"
						: " reading the filtered request view, so redactions and prunings stay removed";
				ctx.ui.notify(
					`rcompact: recall ${value === "off" ? "disabled" : "enabled" + suffix} (written to ${path}; run /reload. Tools register at session start so the tool schema stays stable within a session.)`,
				);
				return;
			}
			if (arg.startsWith("cachepolicy")) {
				const values: Record<string, CachePolicy> = { defer: "defer-after-miss", keep: "keep", native: "native" };
				const value = values[arg.split(/\s+/)[1] ?? ""];
				if (!value) {
					ctx.ui.notify("rcompact: usage: /rcompact cachepolicy defer|keep|native", "error");
					return;
				}
				const path = writeBetterCompactionSetting(ctx.cwd, { cachePolicy: value });
				ctx.ui.notify(
					`rcompact: cache policy set to ${value} (written to ${path}; applies at the next compaction)`,
				);
				return;
			}
			if (arg.startsWith("report")) {
				const value = arg.split(/\s+/)[1];
				if (value !== "on" && value !== "off") {
					ctx.ui.notify("rcompact: usage: /rcompact report on|off", "error");
					return;
				}
				const path = writeBetterCompactionSetting(ctx.cwd, { report: value === "on" });
				ctx.ui.notify(
					`rcompact: post-compaction report ${value === "on" ? "enabled" : "disabled"} ` +
						`(written to ${path}; applies at the next compaction)`,
				);
				return;
			}
			ctx.ui.notify(
				"rcompact: usage: /rcompact [on|off|thinking low|off|inherit|lowbudget <tokens>|sushibudget inherit|<tokens>|report on|off|recall on|off|archive|stored|cachepolicy defer|keep|native]",
				"error",
			);
		},
	};
	pi.registerCommand("bc", compactionCommand);
	pi.registerCommand("rcompact", compactionCommand);

	pi.on("session_before_compact", async (event, ctx) => {
		let telemetry: ReturnType<typeof createCompactionTelemetry> | undefined;
		try {
		requestCapture.resume();
		const { preparation, customInstructions, signal } = event;
		const model = ctx.model;
		// Settle the previous checkpoint's review first: a rejection must be known
		// before this compaction builds on it, so it can be flagged in the prompt.
		await drainDetachedReview(ctx);
		if (!model) return; // no model selected — let pi's normal path report it

		// The whole extension can be switched off via settings; pi's built-in
		// compaction takes over. Read at compaction time so no restart is needed.
		const { settings } = loadPiSettings(ctx.cwd);
		if (settings.betterCompaction?.enabled === false) return;
		telemetry = createCompactionTelemetry(ctx,event);
		attempts.set(ctx.sessionManager.getSessionId(),telemetry);
		const mode = reviewMode(settings.betterCompaction);
		telemetry.update({verificationStatus:mode==="off"?"disabled":"pending",verificationPasses:0,verificationMs:0,verificationIssues:0,revisions:0});

		// 1. Rebuild Pi's canonical request and locate the summary boundary.
		//
		// preparation.firstKeptEntryId marks where pi starts KEEPING messages
		// verbatim; everything before it is what gets summarized and discarded.
		// The agent's last request was [system prompt + full conversation], and
		// the conversation up to the cut is a prefix of that, so prefix/KV
		// caches may cover it. Splash also needs a saved recurrent state, so
		// retain its tail in the request and summarize the current full dialogue.
		const entries = ctx.sessionManager.getEntries();
		// Use Pi's canonical projection so context edits and superseded
		// checkpoints match the actual model request, including repeated compaction.
		const projection = buildSessionProjection(entries, ctx.sessionManager.getLeafId());
		const cutIndex = projection.entries.findIndex((e) => e.sourceEntry.id === preparation.firstKeptEntryId);
		if (cutIndex < 1) { telemetry.finish("fallback",{fallbackReason:"no eligible summary boundary"}); return; }
		telemetry.update({retainedEntries:projection.entries.length-cutIndex,summarizedEntries:cutIndex});
		// Splash's hybrid model can only resume at a saved recurrent state.
		// Cutting the request before that state discards the useful cache even
		// when the KV prefix matches. Preserve the full transcript on Splash;
		// summarize the entire dialogue while Pi retains the original recent tail.
		const preserveCacheTail = supportsRequestCapture(model);
		// Closed-loop cache policy: if the last captured ask was served entirely
		// cold, the engine dropped the resident prefix and Pi's small serialized
		// summary is the cheaper shape for this compaction.
		const cacheKey = ctx.sessionManager.getSessionId();
		const cachePolicy: CachePolicy = settings.betterCompaction?.cachePolicy ?? "defer-after-miss";
		const cacheDecision = selectCachePath(cachePolicy, cacheStates.get(cacheKey), preserveCacheTail);
		cacheStates.set(cacheKey, cacheDecision.state);
		if (cacheDecision.native) {
			telemetry.finish("fallback", {
				fallbackReason: cacheDecision.reason,
				cacheStrategy: "native",
				cachePolicy,
				consecutiveMisses: cacheDecision.state.misses,
				deferredAfterMiss: cachePolicy === "defer-after-miss",
			});
			const warnKey = `${cacheKey}:${cachePolicy}`;
			if (!fallbackWarnings.has(warnKey)) {
				fallbackWarnings.add(warnKey);
				ctx.ui.notify(`rcompact: using native compaction (${cacheDecision.reason}).`, "warning");
			}
			return;
		}
		if (preserveCacheTail) {
			const activation = capturedActivation(model, settings.betterCompaction?.models);
			if (!activation.enabled) { telemetry.finish("fallback",{fallbackReason:activation.reason,cacheStrategy:"native"}); return; }
		}
		const prefixMessages = projection.entries.slice(0, cutIndex).flatMap((e) => e.messages);
		let llmMessages = convertToLlm(preserveCacheTail ? projection.messages : prefixMessages);
		// Recall archives what this checkpoint is about to replace, taken from the
		// filtered request view BEFORE the summary is prepended: text that a
		// redaction hook removed stays removed, so recall can never become a way to
		// read context that another extension deliberately withheld.
		let recallArchived: { generation: number; messages: number; bytes: number } | undefined;
        const snapshot = preserveCacheTail ? requestCapture.get() : undefined;
        if (preserveCacheTail) {
            const desiredThinking = settings.betterCompaction?.thinking ?? "low";
            // A captured ask mirrors the ordinary request's reasoning effort, so
            // "low"/"inherit" no longer need an equal session level: the prefix
            // stays hot and the effort is bounded by sushiThinkingBudget. Only an
            // explicit "off" asks for a body the capture cannot produce.
            const mismatch = validateSnapshot(snapshot, ctx, projection, cutIndex, requestCapture.failureReason()) ??
                (desiredThinking === "off" && snapshot!.reasoning !== undefined ? "compaction thinking off cannot mirror the captured reasoning effort" : undefined);
            if (mismatch) {
                telemetry.finish("fallback",{fallbackReason:mismatch,cacheStrategy:"native"});
                const key = ctx.sessionManager.getSessionId();
                if (!fallbackWarnings.has(key)) {
                    fallbackWarnings.add(key);
                    ctx.ui.notify(`rcompact: using native compaction (${mismatch}).`, "warning");
                }
                return;
            }
            // The exact most recent input already includes ALL normal extension
            // transformations. Later output/results stay in Pi's retained tail;
            // never send untransformed new data through a redaction bypass.
            // Only a carrier for the provider adapter's onPayload callback.
            // summaryPayload replaces it with the exact captured messages and
            // tool schemas before transmission. Keeping another full context
            // here would duplicate screenshots and cannot add valid evidence.
            llmMessages = [{role:"user",content:[{type:"text",text:"Summarize the captured provider request."}],timestamp:Date.now()}];
        }

		// pi's agent filters images out of every request when images.blockImages
		// is enabled (replacing them with a placeholder). Mirror that so the
		// rebuilt prefix matches what the agent actually sent to the LLM.
		if (settings.images?.blockImages && !preserveCacheTail) {
			llmMessages = applyBlockImages(llmMessages);
		}

		// A dangling assistant tool call (aborted mid-turn) is not a valid
		// request on most providers; strip trailing tool calls so the request
		// stays well-formed. Only the last message is affected.
		while (llmMessages.length > 0) {
			const last = llmMessages[llmMessages.length - 1];
			if (last.role === "assistant" && last.content.some((b) => b.type === "toolCall")) {
				const kept = last.content.filter((b) => b.type !== "toolCall");
				if (kept.length === 0) {
					llmMessages.pop();
				} else llmMessages[llmMessages.length - 1] = { ...last, content: kept };
				continue;
			}
			break;
		}
		if (llmMessages.length === 0) { telemetry.finish("fallback",{fallbackReason:"no eligible messages"}); return; }

		// 2. The compaction prompt: pi's summarization system prompt, now
		//    appended at the end of the conversation as a single user message.
		let promptText = SUMMARY_ROLE + "\n\n";
		// Captured requests already contain exactly the context allowed by all
		// hooks. Re-adding raw storage would duplicate checkpoints and bypass
		// redaction/pruning; even a deliberately removed summary must stay removed.
		if (!preserveCacheTail && preparation.previousSummary) {
			promptText += `<previous-summary>\n${preparation.previousSummary}\n</previous-summary>\n\n`;
		}
		promptText += !preserveCacheTail && preparation.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
		if (preserveCacheTail) {
			promptText += "\n\nCACHED CHECKPOINT SCOPE: Summarize the entire last model request above. Any earlier checkpoint visible in that request is historical context; current tool evidence and later verified corrections take precedence. Do not preserve superseded claims just because an earlier checkpoint included them. The latest assistant output and subsequent tool results are not in this request; Pi retains them verbatim after this checkpoint. Do not speculate about that unseen tail. Keep the checkpoint concise; avoid repeating logs or code listings. Preserve the CURRENT state of each task: later verified fixes replace earlier failures, while still-unresolved failures remain explicit. Do not call a task complete without an actual successful result. This full-dialogue checkpoint is intentional: no selected-range or message-count boundary applies.";
		}
		if (customInstructions) {
			promptText += `\n\nAdditional focus: ${customInstructions}`;
		}
		// Loud rejection, part two: the model must not keep building on a checkpoint
		// that failed review, and it must know the raw evidence is still reachable.
		{
			const unverified = unverifiedCheckpoints(reviewQueueFor(ctx.sessionManager.getSessionId()));
			if (unverified.length > 0) {
				promptText += `\n\nUNVERIFIED CHECKPOINTS: ${unverified.slice(0, 4).join(", ")} failed evidence review and are NOT trustworthy. Do not carry their claims forward; re-derive the facts from the current context, or use recall_before_compaction / recall_generations to read the preserved evidence.`;
				telemetry?.update({ unverifiedCheckpoints: unverified.length });
			}
		}

		const requestContext = normalizeContext({
			messages: [
				...llmMessages,
				{
					role: "user",
					content: [{ type: "text", text: promptText }],
					timestamp: Date.now(),
				},
			],
		});

		// 3. Summary/review calls through the configured provider. Same token budget
		//    and thinking level as the built-in compaction, and the same
		//    session id the agent uses so cache-aware backends route to the
		//    same cache. Cache retention stays at the default ("short") — we
		//    want the read, unlike the built-in one-off which uses "none".
		let maxTokens = Math.min(
			Math.floor(0.8 * preparation.settings.reserveTokens),
			model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
		);
		if (preserveCacheTail && model.contextWindow > 0) {
			// Full-history reuse must not send an oversized request. Leave an
			// additional 2K margin for template/token-estimate differences.
			const available = model.contextWindow - preparation.tokensBefore - Math.ceil(promptText.length / 4) - 2048;
			if (available < 2048) return; // native compaction can use a shorter serialized input
			maxTokens = Math.min(maxTokens, available);
		}
		const reviewMaxTokens=Math.min(maxTokens,4096);
		maxTokens=summaryOutputLimit(model,settings.betterCompaction?.sushiMaxTokens,maxTokens);
		// Mirror pi's request wrapper (sdk.ts buildRequestOptions): the agent's
		// requests carry the provider timeout/transport/retry settings from pi's
		// settings, so the compaction request uses the same values.
		const providerRetry = settings.retry?.provider;
		const httpIdleTimeoutMs =
			typeof settings.httpIdleTimeoutMs === "number" ? settings.httpIdleTimeoutMs : 300_000;
		const streamOptions: {
			maxTokens: number;
			signal: AbortSignal;
			sessionId: string;
			cacheRetention: "short";
			reasoning?: Exclude<typeof ctx.thinkingLevel, "off">;
			timeoutMs: number;
			maxRetryDelayMs: number;
			maxRetries?: number;
			websocketConnectTimeoutMs?: number;
			transport?: PiSettings["transport"];
			thinkingBudgets?: PiSettings["thinkingBudgets"];
			samplingParams?: Record<string, unknown>;
			onPayload?: (payload: unknown) => unknown;
			onProviderStreamEvent?: (data: unknown) => void;
		} = {
			maxTokens,
			signal,
			sessionId: ctx.sessionManager.getSessionId(),
			cacheRetention: "short",
			timeoutMs: providerRetry?.timeoutMs ?? (httpIdleTimeoutMs === 0 ? 2_147_483_647 : httpIdleTimeoutMs),
			maxRetryDelayMs: providerRetry?.maxRetryDelayMs ?? 60_000,
			onProviderStreamEvent: (data: unknown) => { const values=providerMeasurements(data); if(Object.keys(values).length)telemetry?.update(values); },
		};
		if (providerRetry?.maxRetries !== undefined) {
			streamOptions.maxRetries = providerRetry.maxRetries;
		}
		if (settings.websocketConnectTimeoutMs !== undefined) {
			streamOptions.websocketConnectTimeoutMs = settings.websocketConnectTimeoutMs;
		}
		if (settings.transport !== undefined) {
			streamOptions.transport = settings.transport;
		}
		if (settings.thinkingBudgets !== undefined) {
			streamOptions.thinkingBudgets = settings.thinkingBudgets;
		}
		// Splash keeps tool descriptions in its prompt under tool_choice=none,
		// preserving the cache prefix while disabling calls during summarization.
		if (preserveCacheTail) {
			streamOptions.samplingParams = { tool_choice: "none" };
			// Pi normally collapses system messages to the beginning of this
			// provider's request. Promote only the appended summary instruction
			// AFTER that conversion, keeping the real conversation prefix intact.
			// Splash advertises native in-place later-system support for this model.
			streamOptions.onPayload = (payload: unknown) => summaryPayload(payload, snapshot!, promptText);
		}
		// Thinking level for the summarization call. Defaults to "low": the
		// summary is short structured output, and inheriting a high session
		// level is wasteful here and can hit the model's thinking cap
		// mid-summary (stopping the compaction). "off" omits the reasoning
		// parameter — the same request the agent sends when session thinking
		// is off — and "inherit" restores the built-in behavior.
		const thinkingChoice = settings.betterCompaction?.thinking ?? "low";
		let effectiveReasoning: Exclude<typeof ctx.thinkingLevel, "off"> | undefined;
		if (model.reasoning) {
			if (preserveCacheTail) {
				// Mirror the option that produced the captured prefix. Pi's adapter maps
				// it to the wire reasoning_effort, so option, headroom estimate and body
				// agree; summaryPayload keeps the captured effort in the payload anyway.
				const mirrored = snapshot?.reasoning as Exclude<typeof ctx.thinkingLevel, "off"> | undefined;
				if (mirrored) streamOptions.reasoning = mirrored;
				effectiveReasoning = mirrored;
				telemetry?.update({
					thinkingMirrored: true,
					configuredThinking: thinkingChoice,
					capturedReasoning: mirrored ?? "none",
				});
			} else if (thinkingChoice === "low") {
				streamOptions.reasoning = "low";
				effectiveReasoning = "low";
			} else if (thinkingChoice === "inherit" && ctx.thinkingLevel && ctx.thinkingLevel !== "off") {
				streamOptions.reasoning = ctx.thinkingLevel;
				effectiveReasoning = ctx.thinkingLevel;
			}
		}
		// Cap the thinking phase when the summarization runs at "low": the
		// summary is short structured output, so an uncapped thinking phase can
		// dominate the response on local models. The cap goes out as a top-level
		// OpenAI-compatible field via samplingParams — pi-ai merges it into the
		// request body last (so it wins over any model-level value) and only
		// OpenAI-compatible adapters apply it, so calls on other APIs are
		// unchanged.
		if (effectiveReasoning === "low" && !preserveCacheTail) {
			// Leave room for the summary itself under the shared response ceiling.
			const capped = Math.min(lowThinkingCap(settings), Math.max(0, maxTokens - MIN_ANSWER_TOKENS));
			if (capped > 0) {
				streamOptions.samplingParams = {
					...streamOptions.samplingParams,
					[resolveThinkingBudgetField(model, settings.betterCompaction?.thinkingBudgetField)]: capped,
				};
			}
		}

		// Same agent-level retry policy pi's built-in compaction uses
		// (settings.retry.*), so the compaction call honors retry.enabled too.
		// The stream is consumed manually (same events .result() uses) so the
		// final attempt can be timed: thinking time is the span from
		// thinking_start until the model moves on to a non-thinking block
		// (text_start/toolcall_start) — OpenAI-compatible adapters emit
		// thinking_end only after the stream has fully ended (blocks are
		// finalized in bulk), so on those backends waiting for thinking_end
		// would swallow the whole summary generation into "thinking" — the
		// rest is generation.
		let timing = { totalMs: 0, thinkingMs: 0 };
		let attemptCount=0;
		let inferencePhase="summary";
		let reviewController: AbortController | undefined;
		let capacityRecovery=false;
		let emptySummaryRecovery=false;
		let summaryRecovery=false;
		let appliedSummaryPolicy: { thinkingBudget: number; focusedExtraction: boolean } | undefined;
		let totalOutputTokens=0,totalPromptTokens=0,totalCacheRead=0,summaryStageMs=0;
		const produce = async (instruction=promptText,outputLimit=maxTokens) => {
			const briefReasoning = inferencePhase !== "verification" && settings.betterCompaction?.sushiBriefReasoning === true &&
				summaryThinkingBudget(model, settings.betterCompaction?.sushiThinkingBudget, outputLimit) !== undefined;
			instruction = summaryReasoningInstruction(instruction, briefReasoning);
			const t0 = Date.now();
			telemetry?.update({phase:"waiting_for_output",inferencePhase,attempts:++attemptCount,cacheStrategy:preserveCacheTail?"captured-request":"prefix"});
			let firstOutput=false;
			let thinkingMs = 0;
			let spanStart: number | null = null;
			let message: AssistantMessage | undefined;
			requestCapture.pause();
			let limit=outputLimit;
			if(preserveCacheTail&&model.contextWindow>0){
				const available=model.contextWindow-preparation.tokensBefore-Math.ceil(instruction.length/4)-2048;
				if(available<1024)throw new Error("Evidence review has insufficient context headroom; original context retained");
				limit=Math.min(limit,available);
			}
			const callContext=instruction===promptText?requestContext:normalizeContext({messages:[...llmMessages,{role:"user",content:[{type:"text",text:instruction}],timestamp:Date.now()}]});
			const summaryBudget = inferencePhase === "verification" ? undefined : summaryThinkingBudget(model, summaryRecovery ? 0 : settings.betterCompaction?.sushiThinkingBudget, limit);
			if (summaryBudget !== undefined) telemetry?.update({ summaryThinkingBudget: summaryBudget, summaryBriefReasoning: briefReasoning });
			if (summaryBudget !== undefined) appliedSummaryPolicy = { thinkingBudget: summaryBudget, focusedExtraction: briefReasoning };
			const callOptions = {
				...streamOptions,
				signal: reviewController?.signal ?? signal,
				maxTokens: limit,
				onPayload: preserveCacheTail
					? (payload: unknown) => {
						const body=applySummaryThinking(summaryPayload(payload, snapshot!, instruction), summaryBudget);
						return capacityRecovery ? freshSummaryPrefix(body, `${telemetry!.id}:${attemptCount}`) : body;
					}
					: summaryBudget !== undefined
						? (payload: unknown) => applySummaryThinking(streamOptions.onPayload?.(payload) ?? payload, summaryBudget)
						: streamOptions.onPayload,
			};
			const stream = await ctx.modelRegistry.streamSimple(model, callContext, callOptions);
			for await (const event of stream) {
				if(!firstOutput&&(event.type==="thinking_delta"||event.type==="text_delta")){firstOutput=true;telemetry?.update({clientTtftMs:Date.now()-t0,phase:event.type==="thinking_delta"?"thinking":"generating"});}
				if (event.type === "thinking_start" && spanStart === null) {
					spanStart = Date.now();
					telemetry?.update({phase:"thinking"});
				} else if (event.type === "thinking_end" ||
					// Close the span as soon as the answer starts: on
					// OpenAI-compatible adapters thinking_end only arrives at
					// stream end, and text_start is the true end of thinking.
					// (On adapters that emit thinking_end mid-stream, it has
					// already closed the span, so text_start is a no-op.)
					event.type === "text_start" || event.type === "toolcall_start") {
					if (spanStart !== null) {
						thinkingMs += Date.now() - spanStart;
						spanStart = null;
					}
					telemetry?.update({phase:"generating"});
				} else if (event.type === "done") {
					message = event.message;
				} else if (event.type === "error") {
					message = event.error;
				}
			}
			if (spanStart !== null) thinkingMs += Date.now() - spanStart; // unclosed span
			timing = { totalMs: Date.now() - t0, thinkingMs };
			telemetry?.update({finalAttemptMs:timing.totalMs,thinkingMs:timing.thinkingMs,phase:"validating"});
			if (!message) throw new Error("Summarization stream ended without a result");
			if(inferencePhase!=="verification")summaryStageMs+=timing.totalMs;
			totalOutputTokens+=message.usage.output;totalPromptTokens+=message.usage.input+message.usage.cacheRead;totalCacheRead+=message.usage.cacheRead;
			telemetry?.update({totalOutputTokens,totalPromptTokens,totalCacheRead,summaryStageMs});
			return message;
		};
		const retryPolicy = {
			enabled: settings.retry?.enabled ?? true,
			maxRetries: settings.retry?.maxRetries ?? 3,
			baseDelayMs: settings.retry?.baseDelayMs ?? 2000,
			maxAgentDelayMs: settings.retry?.maxAgentDelayMs ?? 60_000,
		};
		// A permanent capacity refusal can arrive as HTTP 500. Do not exhaust
		// generic transient retries before trying the one alternate cache prefix.
		const callWithRetry=async(producer:()=>Promise<AssistantMessage>=produce)=>{
			const marker=new Error("Local Sushi capacity refusal");
			let refusal:AssistantMessage|undefined;
			try{return await retryAssistantCall(async()=>{
				const result=await producer();
				if(result.stopReason==='error'&&isSushiPrefillRefusal(model,result.errorMessage)){refusal=result;throw marker;}
				return result;
			},retryPolicy,signal);}catch(error){if(error===marker&&refusal)return refusal;throw error;}
		};
		let response = await callWithRetry();
		// A pinned large prefix can leave insufficient scratch memory even when
		// the same cold input fits. Retry once with a distinct cache key, keeping
		// final filtered messages, tool schemas and normal reasoning template intact.
		if(preserveCacheTail && response.stopReason==='error' && isSushiPrefillRefusal(model,response.errorMessage)){
			capacityRecovery=true;
			telemetry.update({memoryRecovery:'fresh-prefix',memoryRecoveryAttempts:1});
			response=await callWithRetry();
		}

		// 4. Validate like the built-in compaction does: never persist a
		//    partial or failed summary.
		//
		// The summarized conversation is full of real tool calls, so some
		// models — especially smaller local ones — attempt to call a tool
		// instead of just summarizing, despite the prompt forbidding it.
		// Retry a tool attempt once, then fail without replacing the context.
		const hasToolCall = (r: AssistantMessage) => r.content.some((b) => b.type === "toolCall");
		const validateResponse = (r: AssistantMessage) => {
			if (r.stopReason === "aborted") throw new Error("Compaction aborted");
			if (r.stopReason === "error") {
				throw new Error(`Summarization failed: ${r.errorMessage || "Unknown error"}`);
			}
			if (r.stopReason === "length") {
				throw new Error("Summarization failed: generation hit the token cap and the summary is incomplete");
			}
		};
		validateResponse(response);
		// One local recovery covers a thinking-only stop or an answer that ignored
		// the checkpoint schema. Length/errors/aborts/tools never use this repair.
		if (summaryThinkingBudget(model, 0, maxTokens) !== undefined &&
			(isThinkingOnlySummary(response) || needsSummaryFormatRecovery(response))) {
			summaryRecovery = true;
			emptySummaryRecovery = isThinkingOnlySummary(response);
			telemetry.update({summaryRecovery:emptySummaryRecovery?"thinking-only":"missing-sections",summaryRecoveryAttempts:1,
				...(emptySummaryRecovery?{emptySummaryRecovery:true,emptySummaryRecoveryAttempts:1}:{})});
			const recovery = "\nRECOVERY: the previous attempt did not produce a complete checkpoint. Output the factual checkpoint now. Use EXACTLY these section headings, in this order:\n"+
				CHECKPOINT_HEADINGS.map(h=>"## "+h).join("\n")+"\nFill each section from the preserved evidence. No tools; no planning or further analysis.";
			response = await callWithRetry(() => produce(promptText + recovery));
			validateResponse(response);
		}
		if (hasToolCall(response) && !summaryRecovery) {
			response = await callWithRetry();
			validateResponse(response);
		}
		const validateSummary=(r:AssistantMessage)=>{
			validateResponse(r);
			if(hasToolCall(r))throw new Error("Summarization attempted to call a tool");
			const text=stripGeneratedFileMetadata(contentText(r.content));
			if(!text)throw new Error("Summarization returned no text");
			if(!hasCheckpointHeadings(text))throw new Error("Summarization returned an incomplete checkpoint structure; original context retained");
			return text;
		};
		let summaryText=validateSummary(response);
		let verificationPasses=0,revisions=0,verificationMs=0;
		if (mode === "blocking") {
			for (let pass=0; pass<2; pass++) {
				inferencePhase="verification";
				const t=performance.now();
				const reviewed=await callWithRetry(()=>produce(verificationPrompt(summaryText),reviewMaxTokens));
				verificationMs+=performance.now()-t; verificationPasses++;
				validateResponse(reviewed);
				if(hasToolCall(reviewed))throw new Error("Evidence review attempted to call a tool");
				const verdict=parseVerification(contentText(reviewed.content));
				telemetry.update({verificationPasses,verificationMs,verificationIssues:verdict.issues.length,verificationStatus:verdict.valid?"passed":"rejected"});
				if(verdict.valid)break;
				if(pass===1)throw new Error("Summary failed evidence verification twice; original context retained");
				inferencePhase="revision";revisions++;
				response=await callWithRetry(()=>produce(revisionPrompt(promptText,summaryText,verdict)));
				summaryText=validateSummary(response);
				telemetry.update({revisions});
			}
		} else if (mode === "background") {
			reviewController = new AbortController();
			// Detached evidence review (1.2.6). The checkpoint is already
			// committed at this point, and Pi 1.1.0 offers no way to edit or un-apply
			// a compaction entry (appendContextEdit rejects non-message targets; a
			// leaf rewind would abandon the turns taken after the checkpoint). So the
			// review no longer delays compaction by one or three extra slow local
			// inferences: it runs at the next idle boundary and, when it fails, tells
			// the user and the model loudly instead of pretending it could undo.
			const queue = reviewQueueFor(ctx.sessionManager.getSessionId());
			const checkpointKey = `${ctx.sessionManager.getSessionId()}:${telemetry?.id ?? Date.now()}`;
			enqueueReview(queue, checkpointKey);
			detachedJobs.set(ctx.sessionManager.getSessionId(), {
				controller: reviewController,
				queue,
				checkpointKey,
				startedAt: Date.now(),
				telemetry: telemetry ?? undefined,
				run: async () => {
					const reviewStarted = performance.now();
					try {
						inferencePhase = "verification";
						const reviewed = await callWithRetry(() => produce(verificationPrompt(summaryText), reviewMaxTokens));
						validateResponse(reviewed);
						if (hasToolCall(reviewed)) {
							return {
								valid: false,
								issues: ["Evidence review attempted to call a tool"],
								passes: 1,
								revisionMs: 0,
								verificationMs: Math.round(performance.now() - reviewStarted),
							};
						}
						const verdict = parseVerification(contentText(reviewed.content));
						if (verdict.valid) {
							return {
								valid: true,
								issues: [],
								passes: 1,
								revisionMs: 0,
								verificationMs: Math.round(performance.now() - reviewStarted),
							};
						}
						// Rejected: generate the corrected summary so the user is left
						// with something actionable, but do NOT apply it.
						const revisionStarted = performance.now();
						inferencePhase = "revision";
						const corrected = revisionPrompt(promptText, summaryText, verdict);
						const revised = await callWithRetry(() => produce(corrected));
						const replacement = validateSummary(revised);
						return {
							valid: false,
							// Reviewer output is structured claims; flatten to strings for the queue.
							issues: verdict.issues.map((issue) => `${issue.claim} — ${issue.reason}`),
							replacement,
							passes: 1,
							revisions: 1,
							verificationMs: Math.round(performance.now() - reviewStarted),
							revisionMs: Math.round(performance.now() - revisionStarted),
						};
					} finally {
						// produce() pauses request-snapshot capture because a review ask
						// must not be mistaken for an ordinary request. Resume
						// unconditionally: leaving capture paused would silently drop the
						// cache-friendly path for the user's NEXT request.
						inferencePhase = "summary";
						requestCapture.resume();
					}
				},
			});
			telemetry?.update({ verificationStatus: "detached", reviewScheduled: true });
		}else telemetry?.update({verificationStatus:"disabled"});

		// Only archive after a structurally valid, permitted checkpoint exists.
		// The provider payload is authoritative: projection messages precede
		// payload-hook redaction/pruning. Retained messages may also occur here;
		// preserving a filtered request is preferable to guessing a cut boundary.
		if (recallArchive && settings.betterCompaction?.recall && snapshot) {
			const archived=recallArchive.archive(event.reason ?? "manual", snapshot.payload.messages);
			if(archived) {
				recallArchived={generation:archived.id,messages:archived.messages.length,bytes:archived.bytes};
				telemetry.update({recallGeneration:archived.id,recallMessages:archived.messages.length,recallBytes:archived.bytes});
			} else telemetry.update({recallSkipped:true});
		}

		// Pi deliberately skips metadata from hook-generated checkpoints.
		// Merge our own latest *projected* checkpoint; older shadowed checkpoints
		// and unrelated extensions must not resurrect stale file lists.
		const fileOps = {
			read: new Set(preparation.fileOps.read),
			written: new Set(preparation.fileOps.written),
			edited: new Set(preparation.fileOps.edited),
		};
		const previousCheckpoint = projection.entries.find((entry) =>
			entry.sourceEntry.type === "compaction" && entry.messages.length > 0)?.sourceEntry;
		if (previousCheckpoint?.type === "compaction" && previousCheckpoint.fromHook) {
			const details = previousCheckpoint.details as { strategy?: string; readFiles?: unknown; modifiedFiles?: unknown } | undefined;
			if (details?.strategy && (READABLE_STRATEGY_ALIASES as readonly string[]).includes(details.strategy)) {
				if (Array.isArray(details.readFiles)) for (const file of details.readFiles) {
					if (typeof file === "string" && file) fileOps.read.add(file);
				}
				if (Array.isArray(details.modifiedFiles)) for (const file of details.modifiedFiles) {
					if (typeof file === "string" && file) fileOps.edited.add(file);
				}
			}
		}
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		const visibleFiles = snapshot ? filterFileMetadata(snapshot, readFiles, modifiedFiles) : {readFiles, modifiedFiles};
		const summary = summaryText + formatFileOperations(visibleFiles.readFiles, visibleFiles.modifiedFiles);
		telemetry.update({phase:"applying",promptTokens:response.usage.input+response.usage.cacheRead,cacheRead:response.usage.cacheRead,outputTokens:response.usage.output,summaryCharacters:summary.length,finalAttemptMs:timing.totalMs,thinkingMs:timing.thinkingMs});

		// 6. Stash the report (measured on the final attempt — `timing` is
		//    rewritten by every produce() call, so after the validation/retry
		//    step above it holds the final attempt's numbers, not a partial or
		//    pre-validation value) for the session_compact event. It must NOT
		//    be emitted here: session_before_compact runs before pi applies the
		//    compaction result, so a message appended in this handler would
		//    claim "completed" before the compaction lifecycle is finished.
		if (preserveCacheTail) {
			const cacheOutcome = measureCacheOutcome(response.usage, settings.betterCompaction?.cacheMissMinPromptTokens ?? DEFAULT_CACHE_MISS_MIN_PROMPT_TOKENS);
			const nextState = recordCacheOutcome(cacheStates.get(cacheKey), cacheOutcome);
			cacheStates.set(cacheKey, nextState);
			telemetry.update({
				cacheOutcome: cacheOutcome.measured ? (cacheOutcome.missed ? "miss" : "hit") : "unmeasured",
				cachePromptTokens: cacheOutcome.promptTokens,
				consecutiveMisses: nextState.misses,
				deferCompactions: nextState.deferredFor,
			});
		}
		pendingReports.set(ctx.sessionManager.getSessionId(), {
			totalMs: capacityRecovery || mode!=="off"?telemetry.record.elapsedMs:timing.totalMs,
			thinkingMs: timing.thinkingMs,
			cacheRead: response.usage.cacheRead,
			promptTokens: response.usage.input + response.usage.cacheRead,
			tokensBefore: preparation.tokensBefore,
			// A detached review has not happened yet at this point: claiming
			// "passed" here would put an unearned verification badge on the report.
			verificationStatus: mode === "off" ? "disabled" : mode === "blocking" ? "passed" : "detached",
		});

		return {
			compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage: response.usage,
				details: { readFiles, modifiedFiles, strategy: STRATEGY, recall: recallArchived, cacheStrategy: preserveCacheTail ? "captured-request" : "prefix", summaryScope: preserveCacheTail ? "last-request-plus-retained-tail" : "discarded-prefix", ...(appliedSummaryPolicy ? { summaryReasoning: appliedSummaryPolicy } : {}), ...(capacityRecovery ? {memoryRecovery:"fresh-prefix"} : {}), ...(emptySummaryRecovery ? {emptySummaryRecovery:true} : {}), ...(summaryRecovery?{summaryRecovery:emptySummaryRecovery?"thinking-only":"missing-sections"}:{}), verification: {status:mode==="off"?"disabled":mode==="blocking"?"passed":"detached",passes:verificationPasses,revisions} },
			},
		};
		} catch (error) {
			telemetry?.finish(errorCategory(error)==="cancelled"?"cancelled":"failed",{errorCategory:errorCategory(error)});
			requestCapture.resume();
			// Pi catches extension exceptions and otherwise falls back to native
			// compaction. Explicitly cancel so a bad summary never replaces context.
			pendingReports.delete(ctx.sessionManager.getSessionId());
			ctx.ui.notify(`rcompact: ${error instanceof Error ? error.message : String(error)}; original context retained`, "error");
			return { cancel: true };
		}
	});

	// pi fires session_compact only after it has applied the compaction result
	// and completed the compaction lifecycle, so this is where the report is
	// actually emitted. A stashed report exists only when THIS extension
	// supplied the compaction — for the built-in compaction (or when the
	// handler returned early) there is nothing stashed, so no report is sent.
	// The report is appended as a custom session entry: it shows in the chat
	// (see the entry renderer above) and stays in the transcript, but is never
	// sent to the LLM. No UI is required — in non-interactive modes the entry
	// is still persisted and renders whenever the session is viewed.
	pi.on("session_compact", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		// Pi 1.1.0 finds the event entry by first matching summary text. Identical
		// summaries can point at an older checkpoint; use the newest active match.
		const appliedEntry: any = [...(ctx.sessionManager.getBranch?.() ?? [])].reverse().find(
			(entry: any) => entry.type === "compaction" && entry.summary === _event.compactionEntry.summary,
		) ?? _event.compactionEntry;
		const attempt=attempts.get(sessionId);
		let contextMetrics: ReturnType<typeof measureCompactedContext> | undefined;
		try {
			contextMetrics = measureCompactedContext(
				buildSessionProjection(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
				estimateTokens,
			);
		} catch { /* A reporting failure must never invalidate a completed checkpoint. */ }
		if(attempt){
			const ours=(appliedEntry.details as any)?.strategy===STRATEGY;
			// Stamp the review with Pi's real entry id as soon as it exists, so a
			// rejection names the checkpoint the user can actually see.
			{
				const job = detachedJobs.get(sessionId);
				const record = job?.queue.records.get(job.checkpointKey);
				if (record) record.piCheckpointId = appliedEntry.id;
			}
			attempt.finish(ours?"completed":"native_completed",{checkpointId:appliedEntry.id,...contextMetrics,strategy:ours?STRATEGY:"native",...(!ours?{verificationStatus:"not_run"}:{})});attempts.delete(sessionId);
		}
		const report = pendingReports.get(sessionId);
		if (!report) return; // built-in compaction — not ours to report
		pendingReports.delete(sessionId); // emitted exactly once
		// Read at emit time like every other option: report=false hides it.
		const { settings } = loadPiSettings(ctx.cwd);
		if (settings.betterCompaction?.report === false) return;
		pi.appendEntry<CompactionReportData>(REPORT_ENTRY, {
			totalMs: attempt?.record.totalMs ?? report.totalMs,
			thinkingMs: report.thinkingMs,
			cacheRead: report.cacheRead,
			promptTokens: report.promptTokens,
			tokensBefore: report.tokensBefore,
			...contextMetrics,
			verificationStatus: report.verificationStatus,
			attempts: attempt?.record.attempts,
			timestamp: Date.now(),
		});
	});

	// A failed or aborted compaction must not leave a stale report behind that
	// a later session_compact would emit for the wrong compaction. (A shutdown
	// mid-compaction is safe too: the runtime — and this map — is torn down.)
	pi.on("session_compact_failed", (_event, ctx) => {
		const attempt=attempts.get(ctx.sessionManager.getSessionId());
		if(attempt){
			const rejected=attempt.record.status==="failed";
			attempt.finish(rejected?"failed":_event.aborted?"cancelled":"failed",{errorCategory:rejected?attempt.record.errorCategory:_event.aborted?"cancelled":"compaction_failed"});attempts.delete(ctx.sessionManager.getSessionId());
		}
		pendingReports.delete(ctx.sessionManager.getSessionId());
	});
	pi.on("session_shutdown",()=>{for(const attempt of attempts.values())if(attempt.record.status==="running")attempt.finish("interrupted");attempts.clear();});
}
