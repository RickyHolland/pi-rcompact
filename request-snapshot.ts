/** Session-local capture of the request AFTER all ordinary extension hooks.
 * Uses Pi's public custom-provider API; never modifies Pi or writes prompt data.
 */
import { buildSessionProjection, convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { REQUEST_ADAPTER_SYMBOL, REQUEST_DISPATCHER_SYMBOL, REQUEST_CLEANUP_SYMBOL } from "./identifiers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHeadroomGuard } from "./request-headroom";
import { classifySplashStream } from "./provider-errors";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { hasCapability } from "./engine-capabilities";

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const ADAPTER = Symbol.for(REQUEST_ADAPTER_SYMBOL);
const BOOTSTRAP = Symbol.for(REQUEST_DISPATCHER_SYMBOL);
type Observer = { decorate: (model: any, context: any, options: any) => any; ready: () => boolean; clear: () => void };
type Dispatcher = { wrapped: any; observers: Map<string, Set<WeakRef<Observer>>> };
// Pi Web shares and freezes a ModelRuntime after global extension startup.
// Register a stable, stateless transport at startup; attach session observers
// later without mutating that runtime. Weak references do not keep disposed
// SDK sessions (which need not emit session_shutdown) or their transcripts alive.
const dispatchers: Map<string, Dispatcher> = ((globalThis as any)[BOOTSTRAP] ??= new Map());
const cleanup: FinalizationRegistry<{dispatcher: Dispatcher; session: string; ref: WeakRef<Observer>}> = ((globalThis as any)[Symbol.for(REQUEST_CLEANUP_SYMBOL)] ??= new FinalizationRegistry((held: any) => {
  const refs = held.dispatcher.observers.get(held.session);
  refs?.delete(held.ref);
  if (!refs?.size) held.dispatcher.observers.delete(held.session);
}));

export function supportsRequestCapture(model: any): boolean {
  if (model?.api !== "openai-completions") return false;
  if (hasCapability(model, "prefixCacheCapture")) return true;
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(model.baseUrl).hostname); } catch { return false; }
}

function initializeDispatchers(pi: any, providers?: string[], streamSimple?: any) {
  if (typeof pi.registerProvider !== "function") return;
  if (!providers) {
    try {
      const configured = JSON.parse(readFileSync(join(getAgentDir(), "models.json"), "utf8")).providers ?? {};
      providers = Object.entries(configured).filter(([provider, config]: any) => supportsRequestCapture({provider, api: config.api, baseUrl: config.baseUrl})).map(([id]) => id);
    } catch { providers = []; }
  }
  for (const provider of providers) {
    let dispatcher = dispatchers.get(provider);
    if (!dispatcher) {
      const observers = new Map<string, Set<WeakRef<Observer>>>();
      const delegate = streamSimple ?? openAICompletionsApi().streamSimple;
      const wrapped = (model: any, context: any, options: any = {}) => {
        const refs = observers.get(options.sessionId);
        const live: Observer[] = [];
        for (const ref of refs ?? []) { const observer = ref.deref(); if (observer?.ready()) live.push(observer); else if (!observer) refs!.delete(ref); }
        if (refs?.size === 0) observers.delete(options.sessionId);
        // Two live clients opening the same persisted session must never steal
        // each other's captures. Ordinary inference still proceeds unchanged.
        if (live.length > 1) live.forEach(observer => observer.clear());
        return classifySplashStream(model, delegate(model, context, live.length === 1 ? live[0].decorate(model, context, options) : options));
      };
      dispatcher = { wrapped, observers };
      Object.defineProperty(wrapped, BOOTSTRAP, {value: dispatcher});
      dispatchers.set(provider, dispatcher);
    }
    pi.registerProvider(provider, {api: "openai-completions", streamSimple: dispatcher.wrapped});
  }
}
export type Snapshot = {
  sessionId: string;
  provider: string;
  modelId: string;
  reasoning: unknown;
  payload: Record<string, any>;
  canonicalHashes: string[];
  entryIds: string[];
  confirmed: boolean;
  inputTokens?: number;
};

/** Compare immutable message digests rather than retaining another transcript,
 * including its base64 screenshots. Hash before awaiting any extension hook.
 */
export function messageHashes(messages: any[]): string[] {
  return messages.map(message => createHash("sha256").update(JSON.stringify(message)).digest("hex"));
}

/** Canonical file bookkeeping may outlive an extension's filtered checkpoint.
 * Only expose paths still present in the final conversation sent to the model.
 * Decode JSON argument strings too, including escaped Windows/quoted paths.
 */
export function filterFileMetadata(snapshot: Snapshot, readFiles: string[], modifiedFiles: string[]) {
  const text: string[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 12) return;
    if (typeof value === "string") {
      text.push(value);
      if (/^\s*[\[{]/.test(value)) {
        try { visit(JSON.parse(value), depth + 1); } catch { /* Ordinary text. */ }
      }
    } else if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1));
    else if (value && typeof value === "object") Object.values(value).forEach(item => visit(item, depth + 1));
  };
  visit(snapshot.payload.messages);
  const visible = (file: string) => !!file && text.some(value => value.includes(file));
  return { readFiles: readFiles.filter(visible), modifiedFiles: modifiedFiles.filter(visible) };
}

export function validateSnapshot(snapshot: Snapshot | undefined, ctx: any, projection: any, cutIndex: number, missingReason?: string): string | undefined {
  if (!snapshot) return missingReason ?? "no ordinary request captured since session start/reload";
  if (!snapshot.confirmed) return "ordinary request has not completed successfully; use cold compaction";
  if (snapshot.sessionId !== ctx.sessionManager.getSessionId()) return "session changed";
  if (snapshot.provider !== ctx.model?.provider || snapshot.modelId !== ctx.model?.id) return "model changed";
  const reasoning = ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel;
  if (snapshot.reasoning !== reasoning) return "thinking level changed";
  const canonical = convertToLlm(projection.messages);
  if (canonical.length < snapshot.canonicalHashes.length || messageHashes(canonical.slice(0, snapshot.canonicalHashes.length)).some((hash, i) => hash !== snapshot.canonicalHashes[i])) return "conversation was edited, branched, or compacted since capture";
  const captured = new Set(snapshot.entryIds);
  if (projection.entries.slice(0, cutIndex).some((e: any) => !captured.has(e.sourceEntry.id))) return "uncaptured messages would be discarded";
  if (!Array.isArray(snapshot.payload.messages) || snapshot.payload.messages.length === 0) return "provider request format changed";
  return undefined;
}

export function summaryPayload(body: any, snapshot: Snapshot, instruction: string): any {
  if (!body || !Array.isArray(body.messages) || typeof instruction !== "string") throw new Error("Unsupported compaction payload");
  // Preserve the FINAL normal payload, including arbitrary future extension
  // rewrites. Only replace fields needed for a bounded, tool-free summary.
  const captured = structuredClone(snapshot.payload);
  const result = { ...captured, ...body,
    messages: [...captured.messages, {role: "system", content: instruction}],
    tool_choice: "none", parallel_tool_calls: false,
  };
  if (snapshot.payload.tools) result.tools = captured.tools;
  else delete result.tools;
  // Sampling and template flags are inherited from the real request, not from
  // an incomplete reconstruction. Output limits remain those of the summary.
  for (const key of ["temperature", "top_p", "top_k", "min_p", "presence_penalty", "frequency_penalty", "repetition_penalty", "reasoning_effort", "chat_template_kwargs"]) {
    if (key in snapshot.payload) result[key] = structuredClone(snapshot.payload[key]);
    else delete result[key];
  }
  // Do not retain an alternative normal-task ceiling (e.g. a payload hook
  // replacing max_tokens with max_completion_tokens) beside the summary limit.
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    if (key in body) result[key] = body[key];
    else delete result[key];
  }
  delete result.response_format; // A normal-task JSON schema is not a checkpoint schema.
  delete result.stop; // Normal-task stops can truncate the structured checkpoint.
  return result;
}

export function createRequestCapture(pi: any, startup?: {providers: string[]; streamSimple: any}) {
  initializeDispatchers(pi, startup?.providers, startup?.streamSimple);
  const guard=createHeadroomGuard();
  let snapshot: Snapshot | undefined;
  let missingReason = "no ordinary request captured since session start/reload";
  let pendingNormal = false;
  let boundSession: string | undefined;
  let binding: { provider: string; registered: any; original: any; wrapped: any } | undefined;
  let capturing = true;
  let liveCtx: any;
  let epoch = 0;
  let requestSerial = 0;
  let requestOrdinal = 0;
  const pipeline = new AsyncLocalStorage<{serial: number; observed: boolean}>();
  let retired = false;
  let attached: {dispatcher: Dispatcher; session: string; ref: WeakRef<Observer>} | undefined;
  const detach = () => { cleanup.unregister(observer); if (attached) { const refs = attached.dispatcher.observers.get(attached.session); refs?.delete(attached.ref); if (!refs?.size) attached.dispatcher.observers.delete(attached.session); attached = undefined; } };

  // Invalidations also cancel any capture waiting for an async payload hook.
  const clear = (reason = "no ordinary request captured since session start/reload") => { epoch++; snapshot = undefined; pendingNormal = false; missingReason = reason; };
  const ownsProvider = (ctx: any) => {
    const configured = ctx.modelRegistry.getRegisteredProviderConfig?.(binding?.provider);
    return binding && (configured ? configured.streamSimple === binding.wrapped : ctx.modelRegistry.getProvider(binding.provider)?.streamSimple === binding.wrapped);
  };
  pi.on("context_with_system", (_event: any, ctx: any) => {
    // Only the ordinary agent pipeline emits this hook. Direct LLM calls by
    // another extension must never become our normal-request checkpoint.
    if (retired) return;
    liveCtx = ctx;
    pendingNormal = capturing && supportsRequestCapture(ctx.model) && boundSession === ctx.sessionManager.getSessionId();
  });
  pi.on("before_provider_request", () => {
    // This public hook proves that this call came through the ordinary agent
    // pipeline. A helper LLM call from another extension can share sessionId
    // and onPayload, but does not emit the ordinary request hook.
    const marker=pipeline.getStore();
    if(marker){marker.observed=true;requestSerial=Math.max(requestSerial,marker.serial);pendingNormal=false;}
  });
  const decorate = (model: any, context: any, options: any = {}) => {
      const normal = pendingNormal && capturing && !retired && options.sessionId === boundSession && model.provider === binding?.provider;
      const captureEpoch = epoch;
      const captureSession = boundSession;
      const serial = normal ? ++requestOrdinal : requestOrdinal;
      let canonicalHashes: string[] | undefined;
      let entryIds: string[] | undefined;
      if (normal) {
        try {
          const projection = buildSessionProjection(liveCtx.sessionManager.getEntries(), liveCtx.sessionManager.getLeafId());
          canonicalHashes = messageHashes(convertToLlm(projection.messages));
          entryIds = projection.entries.map((e: any) => e.sourceEntry.id);
        } catch { clear("canonical request could not be fingerprinted safely"); }
      }
      return {
        ...options,
        onPayload: async (body: any) => {
          const marker={serial,observed:false};
          const replacement = options.onPayload ? await pipeline.run(marker,()=>options.onPayload(body)) : undefined;
          const final = replacement === undefined ? body : replacement;
          if (normal && marker.observed && canonicalHashes && entryIds && capturing && !retired && captureEpoch === epoch && serial === requestSerial && captureSession === boundSession) {
            try {
              if (!Array.isArray(final?.messages)) { clear("provider request format changed"); return final; }
              const fitted=await guard(model,final,options.signal);
              if (!capturing || retired || captureEpoch !== epoch || serial !== requestSerial || captureSession !== boundSession) return fitted.payload;
              // One exact final payload plus small validation metadata. Do not
              // retain the raw canonical/context copies, even if a later hook
              // removed screenshots or other private data from the payload.
              const candidate: Snapshot = { confirmed:false, inputTokens:fitted.inputTokens, sessionId:captureSession!, provider:model.provider, modelId:model.id, reasoning:options.reasoning, payload:fitted.payload, canonicalHashes, entryIds };
              const size = Buffer.byteLength(JSON.stringify(candidate));
              if (size > MAX_SNAPSHOT_BYTES) { clear(`captured provider request exceeds 16 MiB safety limit (${size} bytes)`); return fitted.payload; }
              snapshot = { ...candidate, payload: structuredClone(fitted.payload) };
              return fitted.payload;
            } catch (error) { clear("provider request could not be captured safely"); if (String(error).includes("context_length_exceeded") || options.signal?.aborted) throw error; }
          }
          return final;
        },
      };
  };
  pi.on("message_end", (event:any) => {
    const m=event.message;
    if (!snapshot || m?.role!=="assistant" || m.provider!==snapshot.provider || m.model!==snapshot.modelId) return;
    if (m.stopReason==="error" || m.stopReason==="aborted") { clear("ordinary request failed or was cancelled; use cold compaction"); return; }
    const usage=m.usage;
    const input=(usage?.input??0)+(usage?.cacheRead??0)+(usage?.cacheWrite??0);
    if (input>0 && (snapshot.inputTokens===undefined || snapshot.inputTokens===input)) snapshot.confirmed=true;
  });
  const observer: Observer = {decorate, clear: () => clear("multiple live clients share this session"), ready: () => pendingNormal && capturing && !retired};
  const bind = (_event: any, ctx: any) => {
    detach();
    clear(); retired = false; capturing = true; liveCtx = ctx; boundSession = ctx.sessionManager.getSessionId();
    if (!supportsRequestCapture(ctx.model)) return;
    if (typeof pi.registerProvider !== "function" || typeof ctx.modelRegistry.getProvider !== "function") return;
    const providerId = ctx.model.provider;
    let original = ctx.modelRegistry.getProvider(providerId);
    if (!original || typeof original.streamSimple !== "function") return;
    const initialized: Dispatcher | undefined = ctx.modelRegistry.getRegisteredProviderConfig?.(providerId)?.streamSimple?.[BOOTSTRAP];
    if (initialized) {
      const ref = new WeakRef(observer);
      const refs = initialized.observers.get(boundSession!) ?? new Set();
      refs.add(ref); initialized.observers.set(boundSession!, refs);
      attached = {dispatcher: initialized, session: boundSession!, ref};
      cleanup.register(observer, attached, observer);
      binding = {provider: providerId, registered: original, original, wrapped: initialized.wrapped};
      return;
    }
    // Rebinding to the same live wrapper would create nested wrappers.
    if (binding?.provider === providerId && ownsProvider(ctx)) return;
    // A reload leaves the old registration in ModelRuntime. Unwrap only our
    // retired adapter; never remove another extension's active provider layer.
    const prior = ctx.modelRegistry.getRegisteredProviderConfig?.(providerId)?.streamSimple?.[ADAPTER];
    if (prior?.retired()) original = prior.original;
    const wrapped = (model: any, context: any, options: any = {}) => classifySplashStream(model, original.streamSimple(model, context, decorate(model, context, options)));
    Object.defineProperty(wrapped, ADAPTER, {value: {original, retired: () => retired}});
    pi.registerProvider(providerId, {api: ctx.model.api, streamSimple: wrapped});
    binding = {provider: providerId, registered: ctx.modelRegistry.getProvider(providerId), original, wrapped};
  };
  pi.on("session_start", bind);
  // SDK clients may begin prompts without emitting the UI startup event.
  pi.on("before_agent_start", (event: any, ctx: any) => {
    if (!binding || binding.provider !== ctx.model?.provider || boundSession !== ctx.sessionManager.getSessionId() || (supportsRequestCapture(ctx.model) && !ownsProvider(ctx))) bind(event, ctx);
  });
  pi.on("model_select", bind);
  pi.on("thinking_level_select", () => clear("thinking level changed since capture"));
  pi.on("session_compact", () => clear("no ordinary request captured after compaction"));
  pi.on("session_shutdown", () => { detach(); clear(); capturing = false; retired = true; liveCtx = undefined; boundSession = undefined; });
  return { get: () => snapshot, failureReason: () => missingReason, clear, pause: () => { epoch++; capturing = false; pendingNormal = false; }, resume: () => { capturing = true; } };
}
