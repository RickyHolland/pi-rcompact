/**
 * Recall over the transcript that compaction replaced.
 *
 * Pi keeps compaction archived in memory only: the pre-compaction messages are
 * the ones the model can no longer see, and after a checkpoint the only
 * faithful copy is the FINAL request payload, because that is what every
 * context/payload hook allowed through. Reading Pi's stored entries instead
 * would resurrect text a user or another extension deliberately redacted or
 * pruned. So an archive entry is built from the filtered view at compaction
 * time and never touches disk.
 *
 * Registration happens at extension load, driven by settings: adding a tool to
 * the active set mid-session makes Pi append a tool-change checkpoint, which
 * invalidates the cached prefix on providers that cannot represent the
 * transition. Opting in through `betterCompaction.recall` plus `/reload` costs
 * nothing but tool-schema tokens on requests that already include them.
 */

export interface RecallMessage {
	role: string;
	text: string;
	/** Tool names called by an assistant message, when any. */
	tools?: string[];
	/** Stored journal id, present only for unfiltered journal hits. */
	entryId?: string;
	/** Non-text content the journal holds but does not surface as evidence. */
	opaque?: string[];
}

export interface RecallGeneration {
	/** Monotonic per-process id; the compaction that produced this entry. */
	id: number;
	reason: string;
	capturedAt: number;
	messages: RecallMessage[];
	bytes: number;
}

export interface RecallLimits {
	/** Archived generations kept before the oldest is dropped. */
	maxGenerations?: number;
	/** Total archived bytes before the oldest generation is dropped. */
	maxBytes?: number;
	/** Characters of a matched message returned per hit. */
	snippetChars?: number;
}

export const DEFAULT_RECALL_LIMITS: Required<RecallLimits> = {
	maxGenerations: 4,
	maxBytes: 8 * 1024 * 1024,
	snippetChars: 700,
};

/** Flattens a filtered LLM message into searchable text. Content blocks only. */
export function toRecallMessage(message: any): RecallMessage | undefined {
	if (!message || typeof message.role !== "string") return undefined;
	const parts: string[] = [];
	const toolNames: string[] = [];
	for (const call of message.tool_calls ?? []) {
		if (typeof call?.function?.name === "string") {
			toolNames.push(call.function.name);
			parts.push(`${call.function.name} ${String(call.function.arguments ?? "")}`);
		}
	}
	const opaque: string[] = [];
	const content = message.content;
	if (typeof content === "string") parts.push(content);
	else if (Array.isArray(content)) {
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
			// Thinking is not surfaced as evidence: it is the model's own draft, and a
			// recalled chain of it would be presented as settled fact. Its presence is
			// reported so a journal reader knows something opaque lives there.
			else if (block.type === "image") opaque.push("image");
			else if (block.type === "thinking" || block.type === "reasoning") {
				const chars = String(block.thinking ?? block.text ?? "").length;
				if (chars > 0) opaque.push(`reasoning:${chars} chars (not surfaced as evidence)`);
			}
			else if (block.type === "toolCall" || block.type === "toolUse") {
				if (typeof block.name === "string") toolNames.push(block.name);
				const args = block.arguments ?? block.input;
				if (args !== undefined) parts.push(`${block.name ?? "tool"} ${safeJson(args)}`);
			} else if (block.type === "toolResult" || block.type === "tool_result") {
				const text = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "";
				if (text) parts.push(text);
			} else if (typeof block.content === "string") parts.push(block.content);
		}
	}
	const text = parts.filter((p) => p.length > 0).join("\n");
	if (!text && toolNames.length === 0 && opaque.length === 0) return undefined;
	const base: RecallMessage = text
		? { role: message.role, text, ...(toolNames.length ? { tools: toolNames } : {}) }
		: { role: message.role, text: "", ...(toolNames.length ? { tools: toolNames } : {}) };
	if (opaque.length > 0) base.opaque = opaque;
	return base;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

export interface RecallArchive {
	generations: RecallGeneration[];
	archive(reason: string, messages: any[], capturedAt?: number): RecallGeneration | undefined;
	search(query: RecallQuery): RecallHit[];
	describe(): { generations: number; messages: number; bytes: number; ids: number[] };
	drop(): void;
}

/** Bounded, in-memory archive of the messages each compaction replaced. */
export function createRecallArchive(limits: RecallLimits = {}): RecallArchive {
	const caps = { ...DEFAULT_RECALL_LIMITS, ...stripUndefined(limits) };
	for (const key of ["maxGenerations", "maxBytes", "snippetChars"] as const) {
		if (!Number.isSafeInteger(caps[key]) || caps[key] < 1) caps[key] = DEFAULT_RECALL_LIMITS[key];
	}
	const generations: RecallGeneration[] = [];
	let nextId = 1;
	let totalBytes = 0;

	const trim = () => {
			while (generations.length > caps.maxGenerations || totalBytes > caps.maxBytes) {
			const oldest = generations.shift();
			if (oldest) totalBytes -= oldest.bytes;
		}
	};

	return {
		generations,
		archive(reason, messages, capturedAt = Date.now()) {
			const archived = messages.map(toRecallMessage).filter((m): m is RecallMessage => m !== undefined);
			if (archived.length === 0) return undefined;
			const bytes = Buffer.byteLength(JSON.stringify(archived));
			// A single oversized checkpoint must not bypass the advertised cap or
			// evict useful older evidence only to leave an empty archive.
			if (bytes > caps.maxBytes) return undefined;
			const generation: RecallGeneration = { id: nextId++, reason, capturedAt, messages: archived, bytes };
			generations.push(generation);
			totalBytes += bytes;
			trim();
			return generation;
		},
		search(query) {
			return searchRecall(generations, query, caps);
		},
		describe() {
			return {
				generations: generations.length,
				messages: generations.reduce((sum, g) => sum + g.messages.length, 0),
				bytes: totalBytes,
				ids: generations.map((g) => g.id),
			};
		},
		drop() {
			generations.length = 0;
			totalBytes = 0;
		},
	};
}

function stripUndefined(values: RecallLimits): RecallLimits {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) if (value !== undefined) out[key] = value;
	return out as RecallLimits;
}

export interface RecallQuery {
	/** Literal substring or regex source, decided by `isRegex`. */
	pattern?: string;
	/** Alternative literals/regexes; matched as OR, capped at 12. */
	patterns?: string[];
	isRegex?: boolean;
	/** Restrict to these roles (e.g. ["user", "assistant"]). */
	roles?: string[];
	/** Restrict to generations at or after this id; default is every generation. */
	fromGeneration?: number;
	/** Maximum hits, capped at MAX_RECALL_LIMIT. */
	limit?: number;
	/** Characters of surrounding context per hit. */
	snippetChars?: number;
	caseSensitive?: boolean;
	/** Only messages that called one of these tools. */
	toolNames?: string[];
}

export interface RecallHit {
	generation: number;
	index: number;
	role: string;
	tools?: string[];
	entryId?: string;
	opaque?: string[];
	snippet: string;
	/** True when the snippet is shorter than the archived message. */
	truncated: boolean;
}

export const MAX_RECALL_LIMIT = 40;
const MAX_RECALL_PATTERNS = 12;

/**
 * Search the archive. A bad regex is reported through `onPatternError` rather
 * than thrown, so a model typo cannot fail the tool call with a stack trace.
 */
export function searchRecall(
	generations: RecallGeneration[],
	query: RecallQuery,
	caps: { snippetChars: number } = DEFAULT_RECALL_LIMITS,
	onPatternError?: (message: string) => void,
): RecallHit[] {
	const rawPatterns = Array.isArray((query as any)?.patterns) ? (query as any).patterns : [(query as any)?.pattern];
	const patterns: string[] = (rawPatterns as unknown[])
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.slice(0, MAX_RECALL_PATTERNS);
	if (patterns.length === 0) return [];
	const limit = Math.max(1, Math.min(Math.floor(query.limit ?? 12), MAX_RECALL_LIMIT));
	const snippetChars = Math.max(80, Math.min(Math.floor(query.snippetChars ?? caps.snippetChars), 4000));
	const roles = (query.roles ?? []).filter((r) => typeof r === "string");
	const toolNames = (query.toolNames ?? []).filter((r) => typeof r === "string");
	const tests: RegExp[] = [];
	for (const pattern of patterns) {
		if (query.isRegex) {
			try {
				tests.push(new RegExp(pattern, query.caseSensitive ? "g" : "gi"));
			} catch (error) {
				onPatternError?.(`Invalid regular expression: ${String((error as Error)?.message ?? error)}`);
				return [];
			}
		}
	}
	const hits: RecallHit[] = [];
	// Newest generations first: after a compaction the model usually wants what
	// it just lost, and the most recent checkpoint replaced the most recent work.
	for (const generation of [...generations].reverse()) {
		if (query.fromGeneration !== undefined && generation.id < query.fromGeneration) continue;
		for (let index = 0; index < generation.messages.length && hits.length < limit; index++) {
			const message = generation.messages[index];
			if (roles.length > 0 && !roles.includes(message.role)) continue;
			if (toolNames.length > 0 && !toolNames.some((name) => message.tools?.includes(name))) continue;
			const haystack = query.caseSensitive ? message.text : message.text.toLowerCase();
			const matched = query.isRegex
				? tests.some((test) => {
						test.lastIndex = 0;
						return test.test(message.text);
					})
				: patterns.some((pattern) => haystack.includes(query.caseSensitive ? pattern : pattern.toLowerCase()));
			if (!matched) continue;
			const position = query.isRegex
				? regexPosition(message.text, tests, query.caseSensitive)
				: literalPosition(haystack, patterns, query.caseSensitive);
			const { snippet, truncated } = excerpt(message.text, position, snippetChars);
			hits.push({
				generation: generation.id,
				index,
				role: message.role,
				...(message.tools ? { tools: message.tools } : {}),
				...(message.entryId ? { entryId: message.entryId } : {}),
				...(message.opaque ? { opaque: message.opaque } : {}),
				snippet,
				truncated,
			});
		}
	}
	return hits;
}

function regexPosition(text: string, tests: RegExp[], caseSensitive?: boolean): number {
	for (const test of tests) {
		test.lastIndex = 0;
		const match = test.exec(text);
		if (match) return match.index;
	}
	return 0;
}

function literalPosition(haystack: string, patterns: string[], caseSensitive?: boolean): number {
	let best = haystack.length;
	for (const pattern of patterns) {
		const needle = caseSensitive ? pattern : pattern.toLowerCase();
		const at = haystack.indexOf(needle);
		if (at >= 0 && at < best) best = at;
	}
	return best >= haystack.length ? 0 : best;
}

function excerpt(text: string, center: number, width: number): { snippet: string; truncated: boolean } {
	if (text.length <= width) return { snippet: text, truncated: false };
	const start = Math.max(0, Math.min(center, text.length - width));
	const end = Math.min(text.length, start + width);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return { snippet: prefix + text.slice(start, end) + suffix, truncated: true };
}

/** Compact rendering for the tool result: labels first, snippets after. */
export function renderHits(hits: RecallHit[], journal = false): string {
	if (hits.length === 0) return "No archived message matches. Use recall_generations to see what is archived.";
	// The journal header is not decoration: without it a raw hit is
	// indistinguishable from filtered archive evidence, and unfiltered text would
	// be presented to the model as something it had already been shown.
	const header = journal
		? "UNFILTERED stored journal: this is what the transcript file holds, so it may contain text that a redaction or pruning hook withheld from the model. Treat it as raw history, not as something the model was shown.\n\n"
		: "";
	return (
		header +
		hits
			.map((hit) => {
				const tools = hit.tools?.length ? ` tools=${hit.tools.join(",")}` : "";
				const entry = hit.entryId ? ` entry=${hit.entryId}` : "";
				const opaque = hit.opaque?.length ? ` opaque=${hit.opaque.join(",")}` : "";
				return `[gen ${hit.generation} msg ${hit.index} role=${hit.role}${entry}${tools}${opaque}]\n${hit.snippet}`;
			})
			.join("\n\n")
	);
}

export function renderGenerations(generations: RecallGeneration[]): string {
	if (generations.length === 0) return "Nothing archived yet: no compaction has run since this process started.";
	return [...generations]
		.reverse()
		.map((generation) =>
			`gen ${generation.id}: ${generation.messages.length} archived messages, ${generation.bytes} bytes, reason=${generation.reason}, capturedAt=${new Date(generation.capturedAt).toISOString()}`,
		)
		.join("\n");
}

/**
 * Minimal view of Pi's session manager that the journal mode needs. Read-only
 * by construction: recall never mutates stored history, so the interface exposes
 * no write, branch, or label method at all.
 */
export interface JournalReader {
	getBranch(fromId?: string): any[];
	getEntry(id: string): any;
}

export interface JournalScope {
	messages: RecallMessage[];
	/** Id of the newest compaction entry whose text replaced these messages. */
	boundaryId?: string;
	/** Entry ids that carry no text evidence, with the reason. */
	skipped: string[];
}

/**
 * The stored transcript that the newest compaction replaced: everything on the
 * current branch before the last `compaction` entry. Messages after that
 * boundary are still in the model's context, so recalling them would be noise.
 */
export function journalScope(manager: JournalReader): JournalScope {
	const entries = manager.getBranch();
	if (!Array.isArray(entries)) return { messages: [], boundaryId: undefined, skipped: [] };
	let boundary = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index]?.type === "compaction") {
			boundary = index;
			break;
		}
	}
	const messages: RecallMessage[] = [];
	const skipped: string[] = [];
	// When nothing has been compacted yet the whole branch is visible to the
	// model; scope the search to it anyway so an early recall is not a false
	// empty result, and let the caller label it unfiltered.
	const window = boundary === -1 ? entries : entries.slice(0, boundary);
	for (const entry of window) {
		if (entry?.type === "message" && entry.message) {
			const converted = toRecallMessage(entry.message);
			if (converted) messages.push({ ...converted, entryId: String(entry.id ?? "") });
			else skipped.push(`${entry.id}:no-text`);
		} else if (entry?.type) {
			skipped.push(`${entry.id}:${entry.type}`);
		}
	}
	return { messages, boundaryId: boundary === -1 ? undefined : String(entries[boundary]?.id ?? ""), skipped };
}

/** Read one stored entry by id, paged by characters. Read-only. */
export function readJournalEntry(
	manager: JournalReader,
	entryId: string,
	offsetChars = 0,
	maxChars = 4000,
): { text: string; totalChars: number; opaque?: string[] } | undefined {
	const entry = manager.getEntry(entryId);
	if (!entry) return undefined;
	const message = entry.type === "message" ? entry.message : undefined;
	if (!message) return { text: `[entry ${entryId} type=${entry.type ?? "unknown"}: no message text]`, totalChars: 0 };
	const converted = toRecallMessage(message);
	const full = converted?.text ?? "";
	const start = Math.max(0, Math.min(Math.floor(offsetChars), full.length));
	// Clamp the upper bound only: a caller asking for 10 characters means 10,
	// otherwise paging would silently return the whole entry.
	const width = Math.max(1, Math.min(Math.floor(maxChars), 20000));
	return {
		text: full.slice(start, start + width),
		totalChars: full.length,
		...(converted?.opaque ? { opaque: converted.opaque } : {}),
	};
}
