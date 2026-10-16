/** One recovery per user run for local Sushi's successful thinking-only stops. */
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isThinkingOnlySummary } from "./summary-recovery";
import { summaryThinkingBudget } from "./summary-thinking";

export interface NormalRecoverySettings { enabled?: boolean; normalThinkingRecovery?: boolean }
export function registerNormalThinkingRecovery(pi: ExtensionAPI, settings: (cwd: string) => NormalRecoverySettings) {
  pi.registerEntryRenderer<{status?:string}>("sushi-turn-recovery", (entry, _options, theme) => {
    if (entry.data?.status !== "exhausted") return undefined;
    return new Text(theme.fg("warning", "Sushi stopped without answering again. Recovery is exhausted; send a new instruction to continue."), 0, 0);
  });
  let sessionId: string | undefined;
  let used = false;
  let pendingBudget = false;
  let warned = false;
  const reset = () => { sessionId = undefined; used = false; pendingBudget = false; warned = false; };
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  // agent_start may fire again for continuation. Only a fresh user prompt resets
  // the allowance, so a repeated empty response cannot create an infinite loop.
  pi.on("before_agent_start", (event, ctx) => {
    // Pi 1.2 also emits this hook for custom-message runs. Only human prompts
    // renew the allowance; an extension continuation must remain bounded.
    if ("messageType" in event && event.messageType === "custom") return;
    reset(); sessionId = ctx.sessionManager.getSessionId();
  });
  pi.on("model_select", () => { pendingBudget = false; });
  pi.on("thinking_level_select", () => { pendingBudget = false; });
  pi.on("agent_settled", () => { pendingBudget = false; });

  pi.on("before_provider_request", (event, ctx) => {
    if (!pendingBudget || sessionId !== ctx.sessionManager.getSessionId()) return;
    pendingBudget = false;
    const config = settings(ctx.cwd);
    if (config.enabled === false || config.normalThinkingRecovery === false ||
        summaryThinkingBudget(ctx.model, 0, ctx.model?.maxTokens ?? 0) === undefined) return;
    const payload = event.payload as Record<string, unknown>;
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) return;
    // Generation-only: keep ordinary messages/tools/sampling/reasoning template.
    // This flag is consumed by this one continuation, never subsequent tool turns.
    return { ...payload, reasoning_budget_tokens: 0 };
  });

  pi.on("turn_end", (event, ctx) => {
    const config = settings(ctx.cwd);
    if (config.enabled === false || config.normalThinkingRecovery === false ||
        sessionId !== ctx.sessionManager.getSessionId() ||
        summaryThinkingBudget(ctx.model, 0, ctx.model?.maxTokens ?? 0) === undefined ||
        event.outcome !== "completed" || event.toolResults.length !== 0 ||
        !isThinkingOnlySummary(event.message)) return;
    // Respect an already scheduled continuation/user message instead of injecting
    // another instruction or overriding its inference settings.
    if (event.continue || ctx.hasPendingMessages() || event.context.pendingMessages.length) return;
    if (used) {
      if (warned) return;
      warned = true;
      if (ctx.hasUI) ctx.ui.notify("Sushi stopped without answering again. Automatic recovery is exhausted; send a new instruction to continue.", "warning");
      return { entries: [{ type: "custom", customType: "sushi-turn-recovery", data: { status: "exhausted", attempt: 1, reason: "thinking-only" } }] };
    }
    used = true; pendingBudget = true;
    if (ctx.hasUI) ctx.ui.notify("Sushi stopped during thinking. Recovering once.", "warning");
    // A public boundary draft becomes a real user-role instruction in the next
    // request, satisfying Pi's continuation contract without altering old history.
    return { continue: true, entries: [{
      type: "custom_message", customType: "sushi-turn-recovery",
      content: "Sushi stopped before responding. Continue the current task from the recorded results; complete the next action or answer without repeating completed actions.",
      display: true, details: { status: "retrying", attempt: 1, reason: "thinking-only" },
    }] };
  });
}
