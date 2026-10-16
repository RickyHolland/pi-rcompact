/** Persisted UI metadata only; never added to model context. All new fields
 * are optional so reports saved by older extension versions still render. */
export interface CompactionReportData {
	totalMs: number;
	thinkingMs: number;
	cacheRead: number;
	promptTokens?: number;
	tokensBefore?: number;
	tokensAfterEstimate?: number;
	summaryTokensEstimate?: number;
	retainedMessages?: number;
	verificationStatus?: string;
	attempts?: number;
	timestamp: number;
}

const validCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const count = (n: number) => Math.round(n).toLocaleString("en-GB");

/** Measure the applied projection, never the discarded draft or stale usage
 * on retained assistant messages. The estimator is Pi's estimateTokens. */
export function measureCompactedContext(
	messages: readonly { role: string }[],
	estimate: (message: any) => number,
): Pick<CompactionReportData, "tokensAfterEstimate" | "summaryTokensEstimate" | "retainedMessages"> {
	let tokensAfterEstimate = 0, summaryTokensEstimate = 0, retainedMessages = 0;
	for (const message of messages) {
		const tokens = estimate(message);
		if (!validCount(tokens)) throw new Error("Invalid context token estimate");
		tokensAfterEstimate += tokens;
		if (message.role === "compactionSummary") summaryTokensEstimate += tokens;
		else if (message.role !== "system") retainedMessages++;
	}
	return { tokensAfterEstimate, summaryTokensEstimate, retainedMessages };
}

export function formatCompactionReport(report: CompactionReportData): string {
	const timing: string[] = [];
	if (validCount(report.thinkingMs) && report.thinkingMs > 250) timing.push(`${(report.thinkingMs / 1000).toFixed(1)}s final-attempt thinking`);
	if (validCount(report.attempts) && report.attempts > 1) timing.push(`${count(report.attempts)} inference calls`);
	const lines = [`Compaction completed in ${(report.totalMs / 1000).toFixed(1)}s${timing.length ? ` (${timing.join(", ")})` : ""}.`];
	if (validCount(report.tokensBefore) && validCount(report.tokensAfterEstimate)) {
		const before = report.tokensBefore, after = report.tokensAfterEstimate, saved = before - after;
		let change = "";
		if (before > 0) {
			change = saved >= 0
				? ` · ${(100 * saved / before).toFixed(1)}% smaller (${count(saved)} freed)`
				: ` · ${(100 * -saved / before).toFixed(1)}% larger (${count(-saved)} added)`;
		}
		lines.push(`Context (estimated): ${count(before)} → ${count(after)} tokens${change}`);
	}
	const details: string[] = [];
	if (validCount(report.summaryTokensEstimate)) details.push(`Summary ≈${count(report.summaryTokensEstimate)} tokens`);
	if (validCount(report.retainedMessages)) details.push(`Kept ${count(report.retainedMessages)} ${report.retainedMessages === 1 ? "message" : "messages"}`);
	if (validCount(report.promptTokens) && report.promptTokens > 0 && validCount(report.cacheRead) && report.cacheRead <= report.promptTokens) {
		details.push(`${(100 * report.cacheRead / report.promptTokens).toFixed(1)}% summary input cached`);
	} else if (validCount(report.cacheRead) && report.cacheRead > 0) details.push(`${count(report.cacheRead)} summary input tokens from cache`);
	if (report.verificationStatus === "disabled") details.push("Review off");
	else if (report.verificationStatus === "passed") details.push("Review passed");
	else if (report.verificationStatus === "detached" || report.verificationStatus === "pending") details.push("Review pending at next idle boundary");
	if (details.length) lines.push(details.join(" · "));
	return lines.join("\n");
}
