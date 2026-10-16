/**
 * Engine capabilities.
 *
 * Behaviour that depends on what a serving engine actually supports is decided here instead of
 * being hard-coded to a provider id, so a different oMLX-derived server (or a renamed local
 * provider) can be granted the same handling without a code change. Capability grants are
 * separate from transport trust: every consumer still verifies the loopback/`https` rule itself,
 * so granting a capability to a provider never widens where requests are sent.
 */

import { modelPatternMatches } from "./activation";

export type EngineCapability =
	/** Accepts `reasoning_budget_tokens` at generation time and mirrors a captured reasoning effort. */
	| "reasoningBudget"
	/** Follows a short explicit "think briefly" instruction in the system prompt. */
	| "briefReasoningInstruction"
	/** Reports a prefill that does not fit as a retryable capacity refusal (HTTP 500 or 429). */
	| "prefillCapacityRecovery"
	/** Keeps prefix affinity for an identical request body, so capturing the final request pays off. */
	| "prefixCacheCapture"
	/** Reserves context for output, so a near-full prompt needs a tokenizer-preflight headroom fit. */
	| "outputHeadroomGuard"
	/** Reports an engine restart inside an HTTP 200 SSE stream as a plain error event. */
	| "engineRestartErrors";

export interface EngineModel {
	provider?: string;
	api?: string;
	id?: string;
	baseUrl?: string;
}

/** Fallback grants when nothing is configured: exactly the historical provider-id behaviour. */
const BUILTIN: Record<string, EngineCapability[]> = {
	sushi: ["reasoningBudget", "briefReasoningInstruction", "prefillCapacityRecovery"],
	splash: ["prefixCacheCapture", "outputHeadroomGuard", "engineRestartErrors"],
	omlx: ["prefixCacheCapture"],
};

const ALL: EngineCapability[] = [
	"reasoningBudget", "briefReasoningInstruction", "prefillCapacityRecovery",
	"prefixCacheCapture", "outputHeadroomGuard", "engineRestartErrors",
];

let configured: Record<string, EngineCapability[] | "all" | "none"> | undefined;

/** Install the configured overrides for the current settings. Call it on every settings load. */
export function configureEngineCapabilities(
	rules: Record<string, EngineCapability[] | "all" | "none"> | undefined,
): void {
	configured = rules;
}

function normalize(value: unknown): EngineCapability[] | "all" | "none" | undefined {
	if (value === "all" || value === "none") return value;
	if (!Array.isArray(value)) return undefined;
	return value.filter((c): c is EngineCapability => ALL.includes(c as EngineCapability));
}

/** Match keys use the same glob language as `models`: provider id, or `provider/modelId`. */
function matches(key: string, model: EngineModel): boolean {
  const provider = String(model.provider ?? "").toLowerCase();
  const id = String(model.id ?? "").toLowerCase();
  return modelPatternMatches(key.toLowerCase(), [provider, `${provider}/${id}`]);
}

/**
 * Capabilities granted to `model`. Configured rules win over the built-in grants; the most
 * specific matching key (a `provider/modelId` rule, then a provider rule) is applied last. A grant
 * only decides what the engine supports — each consumer keeps its own request-shape and transport
 * requirements, so a capability never widens where a request is sent.
 */
export function capabilitiesFor(model: EngineModel | undefined | null): Set<EngineCapability> {
	const caps = new Set<EngineCapability>();
	if (!model) return caps;
	const grants: Array<EngineCapability[] | "all" | "none"> = [];
	for (const table of [BUILTIN, configured ?? {}]) {
		if (!table || typeof table !== "object") continue;
		for (const [match, raw] of Object.entries(table)) {
			const value = normalize(raw as unknown);
			if (!value || !matches(match, model)) continue;
			grants.push(value);
		}
	}
	for (const grant of grants) {
		if (grant === "none") caps.clear();
		else if (grant === "all") for (const c of ALL) caps.add(c);
		else for (const c of grant) caps.add(c);
	}
	return caps;
}

export function hasCapability(model: EngineModel | undefined | null, cap: EngineCapability): boolean {
	return capabilitiesFor(model).has(cap);
}

/**
 * Transport trust, kept separate from capability grants: a local engine reachable over plain HTTP
 * on loopback only. Generation-time parameters and tokenizer preflights are never sent elsewhere.
 */
export function isLoopbackHttp(model: EngineModel | undefined | null): boolean {
	if (typeof model?.baseUrl !== "string") return false;
	try {
		const url = new URL(model.baseUrl);
		return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
	} catch {
		return false;
	}
}
