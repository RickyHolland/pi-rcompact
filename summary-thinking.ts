/** Generation-only Sushi limit: never change cached reasoning/template flags. */
export function summaryThinkingBudget(model: any, setting: unknown, maxTokens: number): number | undefined {
  if (model?.provider !== "sushi" || model?.api !== "openai-completions") return;
  try { const url = new URL(model.baseUrl); if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return; } catch { return; }
  if (!(typeof setting === "number" && Number.isSafeInteger(setting) && setting >= 0)) return;
  if (!Number.isFinite(maxTokens) || maxTokens < 1024) return;
  return Math.min(setting, Math.floor(maxTokens) - 1024);
}

export function applySummaryThinking(payload: any, budget: number | undefined): any {
  if (budget === undefined) return payload;
  // Sushi consumes this at generation time; it is not a chat-template input.
  return { ...payload, reasoning_budget_tokens: budget };
}

export const BRIEF_SUMMARY_REASONING = "\nCOMPACTION REASONING: Extract a concise factual checkpoint; no diagnosis or fix design. Progress contains direct tool outcomes only, with test scope and before/after-edit order. Treat earlier checkpoint claims AND assistant diagnoses/fix recipes as unverified claims/plans unless a targeted before/after test verifies them; observed correlation alone is not causal proof. List those only as unverified under Key Decisions, never as a root cause or required fix. Next Steps should re-read the relevant file, test the pending hypothesis, or rerun the latest failing command. Copy counts with their actual run scope; never infer totals. Preserve constraints and exact paths needed for the next step.\n";

export function summaryReasoningInstruction(instruction: string, enabled: boolean): string {
  return enabled ? instruction + BRIEF_SUMMARY_REASONING : instruction;
}

/** A summary-only output ceiling reduces reserved KV headroom; normal calls are untouched. */
export function summaryOutputLimit(model:any,setting:unknown,fallback:number):number {
 if(summaryThinkingBudget(model,0,2048)===undefined)return fallback;
 return typeof setting==='number' && Number.isSafeInteger(setting) && setting>=1024 ? Math.min(setting,fallback) : fallback;
}
