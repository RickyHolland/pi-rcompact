# pi-rcompact

![CI](https://github.com/RickyHolland/pi-rcompact/actions/workflows/ci.yml/badge.svg)

Cache-aware context compaction for [Pi](https://pi.dev), the coding agent. It takes
over Pi's manual `/compact` and its automatic threshold/overflow compaction, and asks
the model for the summary **on the exact request Pi was already sending** instead of in
a throwaway chat — so the backend's prompt cache is reused instead of discarded.

Compaction is the moment a conversation is at its longest. Pi's built-in path
summarizes it in a brand-new chat: system prompt explaining how to compact, then the
whole transcript below it. That request shares nothing with the chat that was just
running, so the KV/prefix cache is useless and the model re-prefills every token —
every single time.

```
built-in:  [ compaction instructions ] + [ whole transcript ]         ← cold prefill
rcompact:  [ the transcript the model already has cached ] + [ compact this ]   ← cache hit
```

rcompact also refuses to lose data on your behalf: an empty, truncated, malformed or
tool-calling summary **cancels compaction and keeps your original transcript**, and any
missing or unsafe capture silently yields to Pi's native compaction.

> Derived from [BetterCompaction](https://github.com/NotSoSeriouss/BetterCompaction)
> by Michele Pollidori (MIT), which introduced the cache-reusing summary request. This
> project extends it with capture eligibility, evidence review, recall over the replaced
> transcript, output-headroom fitting and metadata-only telemetry. See
> [License and attribution](#license-and-attribution).

## Install

Requires Pi ≥ 1.1 (developed and verified against Pi 1.1.0–1.2.0; CI additionally runs the
full suite against the newest published Pi, currently 1.3.0) and Node ≥ 22.19.
No npm dependencies: Pi supplies the extension host packages.

As a Pi package from git — **pin the release tag**:

```sh
pi install git:github.com/RickyHolland/pi-rcompact@v1.1.0
```

The tag is what the release notes name, and Pi installs that ref exactly. Without `@…`, Pi
resolves the repository's default branch, which moves as soon as a change merges: you would
be running a commit nobody has released. `main` is protected (CI must pass, force-push and
deletion are blocked, released `v*` tags cannot be deleted), but pinning is still the form to
use, because it means the copy on your machine corresponds to a reviewed release rather than
"whatever `main` was today". Check the [releases page](https://github.com/RickyHolland/pi-rcompact/releases) for the newest tag.

> **`v1.1.0` is the current release, and `v1.0.4` the earliest pin that still resolves.** Tags
> `v1.0.0`–`v1.0.3` no longer resolve, so an install pinned to one of them fails and needs
> re-pinning. Those versions remain documented as CHANGELOG entries, and their behaviour is
> included in every later release.

To update later, install the newer tag — the pinned ref is what Pi re-fetches:

```sh
pi uninstall git:github.com/RickyHolland/pi-rcompact && pi install git:github.com/RickyHolland/pi-rcompact@v1.1.0
```

Then start a new Pi session, or run `/reload` in an existing one. Pi Web needs a daemon
restart to reload extension code.

From a clone (check out the tag, so the working tree matches a release):

```sh
git clone --branch v1.1.0 --depth 1 https://github.com/RickyHolland/pi-rcompact
pi install ./pi-rcompact
```

Nothing else to configure: with no settings present, rcompact is enabled, reviews
summaries against their source before applying them, and appends a completion report.

### Confirm it is working

```
/rcompact          → shows enabled state, cache policy and streak, model activation,
                     evidence review mode, recall state, and whether a request snapshot is ready
/compact           → run a compaction; the report shows tokens before → after and cache reuse
```

The first compaction in a session uses Pi's native path unless an ordinary request has
already succeeded — rcompact only summarizes a request that really went out. Run
`/rcompact check` after upgrading Pi to re-verify compatibility against the runtime
you actually have installed (a few minutes; no inference, no writes to your settings or sessions).

## Commands

`/rcompact` and its legacy alias `/bc` share one command. Changes are written to the
settings file that currently provides the `betterCompaction` section — the project file
(`.pi/settings.json`) when it defines one, otherwise the global file
(`~/.pi/agent/settings.json`) — and apply at the next compaction unless stated otherwise.

| Command | Effect |
| --- | --- |
| `/rcompact` | Print effective configuration, cache policy and miss streak, model activation, review mode, recall archive and snapshot readiness |
| `/rcompact on` / `off` | Enable rcompact, or hand compaction back to Pi native without disabling Pi's automatic compaction |
| `/rcompact thinking low\|off\|inherit` | Thinking level for the summarization call (see [thinking](#thinking-and-summary-length)) |
| `/rcompact lowbudget <tokens>` | Max thinking tokens when the summary runs at `low` (`0` = no cap) |
| `/rcompact sushibudget inherit\|<tokens>` | Engine-side reasoning budget for local Sushi summary calls (`0` forces immediate closure) |
| `/rcompact verify blocking\|background\|off` | Evidence review policy (see [review](#evidence-review)) |
| `/rcompact turnrecovery on\|off` | One recovery continuation for local-Sushi thinking-only ordinary turns |
| `/rcompact models auto\|<glob> [<glob>…]` | Which models may use the long captured-request ask; `*` and `?` supported, case-insensitive |
| `/rcompact recall on\|off\|archive\|stored` | Recall tools over the transcript compaction replaced. Needs `/reload` |
| `/rcompact cachepolicy defer\|keep\|native` | What a *measured* prefix-cache miss does to the next compaction |
| `/rcompact report on\|off` | Post-compaction completion report |
| `/rcompact check` | Run the full compatibility suite against the installed Pi runtime |

## Settings

`~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project, wins):

```json
{
  "betterCompaction": {
    "enabled": true,
    "report": true,
    "thinking": "inherit",
    "verify": "blocking",
    "cachePolicy": "defer-after-miss",
    "recall": false
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` → Pi's built-in compaction runs instead |
| `report` | `true` | Append the completion report to the transcript (never sent to the model) |
| `thinking` | `"low"` | `"low"`, `"off"` or `"inherit"` for the summary call on the serialized prefix path. On the captured path the ordinary request's reasoning effort is *mirrored* — see [thinking](#thinking-and-summary-length) |
| `lowThinkingBudget` | `2048` | Thinking-token cap when the effective level is `"low"` |
| `thinkingBudgetField` | `"auto"` | Which wire field carries that cap: `thinking_budget`, `thinking_token_budget` or `thinking_budget_tokens` |
| `verify` | `"blocking"` | `true`/`"blocking"`, `"background"` or `false`/`"off"` |
| `models` | unset | Explicit model globs that may use the captured-request ask; otherwise only models reporting zero input **and** zero cache-read price |
| `cachePolicy` | `"defer-after-miss"` | `defer` / `keep` / `native` |
| `cacheMissMinPromptTokens` | `2048` | Below this prompt size a zero-cache-read ask is `unmeasured`, not a miss |
| `normalThinkingRecovery` | `true` | Local-Sushi thinking-only ordinary-turn recovery |
| `sushiThinkingBudget` | unset | `reasoning_budget_tokens` for local Sushi summary calls |
| `sushiMaxTokens` | unset | Total summary/revision output cap (integer ≥ 1024) |
| `sushiBriefReasoning` | `false` | Focused-extraction instruction on budgeted Sushi summary calls |
| `engineCapabilities` | built-in table | Per-engine capability grants, keyed by provider id or `provider/modelId` glob — see [engine capabilities](#engine-capabilities) |
| `recall` | `false` | Register the two recall tools (read at session start; needs `/reload`) |
| `recallJournal` | `"archive"` | `"archive"` = filtered request view; `"stored"` = also read Pi's session journal (unfiltered, see [recall](#recalling-what-compaction-dropped)) |
| `recallMaxGenerations` / `recallMaxBytes` | `4` / `8 MiB` | In-memory recall archive bounds |

Pi's own `compaction.reserveTokens` / `keepRecentTokens` still decide *when* compaction
happens and how much tail is kept. rcompact changes *how the summary is asked for*.

### Engine capabilities

Behaviour that depends on what a serving engine supports is granted per engine in
`engineCapabilities` rather than being gated on a provider id. Keys are provider ids or
`provider/modelId` globs (`*` and `?`, case-insensitive — the same language as `models`); values
are a list of capability names, `"all"`, or `"none"`. Configured rules are added to the built-in
grants in order, and `"none"` clears grants, so a rule can enable an engine the built-in table has
never heard of, or switch an engine off entirely:

| Capability | What it enables | Built-in grants |
| --- | --- | --- |
| `reasoningBudget` | `reasoning_budget_tokens` on the summary call, plus mirroring the captured reasoning effort | `sushi` |
| `briefReasoningInstruction` | The focused-extraction instruction, used with `sushiBriefReasoning` | `sushi` |
| `prefillCapacityRecovery` | One retry with a fresh cache prefix when the engine reports a prefill that does not fit | `sushi` |
| `prefixCacheCapture` | Capture the exact final request and summarize against it (prefix affinity) | `splash`, `omlx` |
| `outputHeadroomGuard` | Tokenizer preflight that fits the prompt into the context the engine has left for output | `splash` |
| `engineRestartErrors` | Treat a 503 reported inside an HTTP 200 SSE stream as the retryable error it is | `splash` |

```json
"engineCapabilities": {
  "myllama": ["prefixCacheCapture", "outputHeadroomGuard"],
  "splash/legacy-*": "none"
}
```

`/rcompact` prints the capabilities granted to the current model. A grant only decides what an
engine supports: transport trust stays separate, so generation-time parameters and tokenizer
preflights are still sent only to a loopback `http://` engine, and request capture still requires an
OpenAI-compatible request shape. Granting a capability never widens where your conversation is sent.

## How it decides

Every compaction resolves to one of three strategies, and a fallback always states its
reason instead of failing silently:

1. **Captured request** — the exact final OpenAI-compatible payload of the last
   successful ordinary request (messages, tools, sampling, template flags, after every
   context and payload hook). The summary instruction is appended as the final message,
   so the prefix stays byte-identical and the engine serves it from cache.
2. **Serialized prefix** — for APIs rcompact cannot capture: it reconstructs the
   conversation from Pi's entries and sends the same compact-this-transcript shape.
   Pi's `keepRecentTokens` tail is still excluded so the summary does not re-describe
   messages that stay in the session.
3. **Pi native** — missing/unsafe/stale capture, model or thinking change, branch or
   context edit, an oversized capture (> 16 MiB), a deferred cache miss, or a model that
   did not qualify. Pi's own compaction runs, unchanged.

A capture becomes eligible only after an ordinary request succeeded with positive input
usage. Rejected, cancelled and failed requests clear it, and a capture never survives
`/reload`, a branch, or a context edit.

### Evidence review

`"blocking"` (the default) checks each draft summary against the same filtered source
that produced it, revises once after a rejection, and retains history if the second
verdict fails too. `"background"` applies a structurally valid summary immediately,
labels review pending, and reviews at the next idle boundary; a rejection writes a
durable warning that tells the next model turn to treat that checkpoint as unverified.
Review adds real latency — tens of seconds on a long transcript — because it is a second
inference call. It is a second reading *by the same model*, not independent
verification, and it cannot guarantee a summary is free of unsupported claims.

### Recalling what compaction dropped

A checkpoint summarizes; it does not remember. Off by default, `/rcompact recall on`
registers two read-only tools over the pre-compaction request:

- `recall_before_compaction` — literal or regex search, newest checkpoint first,
  filterable by role, tool name and generation, with excerpts centred on the match.
- `recall_generations` — what is archived, so the model knows a recall is possible.

Enabling it costs tokens on **every** ordinary request (a tool declaration is always
sent), so it is a deliberate trade. In the default `"archive"` mode the source is the
filtered request view: text a redaction or pruning hook withheld stays withheld.
`"stored"` mode additionally reads Pi's session journal, which holds original text —
maximum reach, and it survives a restart, but its results are labelled `UNFILTERED`
because they can surface what a hook removed. Thinking blocks are never surfaced as
evidence, and nothing is written to disk.

### Thinking and summary length

With some engines the thinking mode is applied at the chat-template level, so switching
it mid-session re-renders the prompt and forces a full re-prefill — exactly the cost this
extension exists to avoid. On the captured path rcompact therefore **mirrors** the
ordinary request's reasoning option rather than overriding it, keeping the prefix
identical. To genuinely shorten the thinking phase of a captured compaction without
forking the prefix, use an engine-side generation bound (`sushibudget` /
`sushiThinkingBudget`): it bounds thinking, it does not change the template.
`thinking: "off"` stays a native fallback, because omitting reasoning requires
overriding a mirrored template flag — a quality change rcompact will not make silently.

### Output headroom

For local Splash-style engines, the final payload is rendered and counted through the
engine's own `/apply-template` and `/tokenize` endpoints after other extensions finish
their hooks. This performs no inference. The output limit is lowered only when needed to
fit the remaining context; if the prompt leaves fewer than 1,024 output tokens, a
recognized overflow error invokes Pi's existing single compact-and-retry recovery
instead of replaying a rejected request with its full tool loadout.

## Verification

What "it works" is based on, and what it is not:

- 143 unit checks plus six integration suites that drive the **real Pi SDK** (fake loopback
  provider, no inference, no writes outside temp dirs), run with the payload-hook ordering
  both ways because Pi has changed it before.
- `npm run typecheck` and `npm test` are green in CI on Node 22 and 24, and the offline suite
  is green against the newest published Pi (1.3.0) as well as the 1.2.0 used in development.
- End-to-end live runs against a real local model, and headless screenshot comparisons on
  sessions with 4–5 screenshots and ~1.86M tokens, verified the exact final payload, retained
  images, reload, and the three-way ordering of compaction / context capture / exit journal.
- **Not** a claim about a specific token or cost reduction on your provider: those numbers
  depend on your engine and cache behaviour, and the earlier internal measurements were taken
  on a local model that most users do not run.

## Safety model

- Invalid, empty, truncated or tool-calling summaries cancel compaction and retain the
  original transcript.
- Snapshots live in session memory only and are never written to disk. A capture retains
  one immutable final provider payload plus per-message SHA-256 digests and entry ids, so
  screenshot-heavy sessions are not counted *and* retained; captures over 16 MiB are
  skipped with the actual size reported.
- Asynchronous payload hooks are fenced by request/session generations, so a late result
  cannot repopulate a retired snapshot; reloads retire the old adapter rather than
  stacking wrappers.
- Two live clients opening the same session id cannot steal each other's captures;
  ambiguous clients simply do not capture.
- Session observers are weakly referenced and detached on shutdown/reload. Startup
  registration supports Pi Web's shared frozen `ModelRuntime`.
- Telemetry is metadata only, under the active Pi profile at
  `telemetry/rcompact/`: lifecycle, trigger, provider/model, timings, retries,
  cache usage, output tokens, retained entries, estimated reduction. No prompts,
  summaries, tool arguments, file paths, credentials or raw provider errors. A telemetry
  failure never prevents compaction.
- Compaction reports and review warnings are stored as custom session entries: they stay
  in your transcript, survive reload, and are never sent to the model.

## Known limitations

Read these before deciding it is right for your setup.

- **Cache reuse is not guaranteed.** rcompact sends a cache-friendly request; the engine
  still has to be holding the prefix. Unloads, eviction and competing requests cause
  legitimate misses, which is why `cachePolicy: defer` hands the *next* compaction back to
  native after one measured miss, and why a provider that reports no usage is treated as
  `unmeasured` rather than as a miss.
- **Capture covers OpenAI-compatible APIs.** Any loopback OpenAI-compatible provider
  qualifies (`localhost`, `127.0.0.1`, `::1`) — llama.cpp-style servers, vLLM, LM Studio,
  Ollama's OpenAI endpoint. Remote and non-OpenAI APIs keep the serialized-prefix path.
- **Some extras are engine-specific.** The reasoning-budget bound, brief-reasoning instruction,
  prefill-capacity recovery, request-capture affinity, output-headroom guard and
  restarting-engine error classification are granted per engine rather than assumed. The built-in
  grants cover the ids this project is developed against; any other engine is enabled by
  configuration — see [engine capabilities](#engine-capabilities). Core capture, review, recall and
  fallback still apply everywhere.
- **Free-input pricing gates the long path.** By default only models reporting zero
  input *and* zero cache-read cost may use it, because the ask re-sends the transcript.
  Override deliberately with `/rcompact models <glob>`.
- **A checkpoint edit invalidates the capture.** rcompact deliberately does not ship a
  "preserve mode" that rewrites history while keeping a cached request — the public SDK
  cannot replace an applied checkpoint for rollback, and projection edits force
  invalidation. [DESIGN.md](DESIGN.md) records that investigation.
- **Future Pi APIs.** No third-party extension can guarantee compatibility with arbitrary
  future host APIs. The offline suite is deterministic but is validated against specific Pi
  builds; a module-import break can still need an update, and `/rcompact check` tells you
  quickly. Every fallback keeps compaction working.

## Development

```sh
npm install --ignore-scripts --legacy-peer-deps   # pinned dev deps (TypeScript, types)
npm run typecheck
npm test
```

`npm test` is fully offline: 143 unit checks plus real Pi SDK integration in both
payload-hook orders against a temporary loopback fixture provider. It performs no model
inference, writes only to temp directories, and never touches your `~/.pi` settings or
sessions. It needs an installed Pi runtime; discovery covers `npm -g`, Homebrew, nvm,
Volta and custom prefixes, or set `PI_TEST_ROOT=/path/to/pi-coding-agent`. Optionally
set `PI_MEMORY_EXTENSION` to load a third-party extension alongside this one and prove
the captured prefix survives a real extension stack.

Deliberately outside `npm test`, because they use real inference and expect an idle
local engine:

```sh
npm run test:live          # real-engine summary ask, isolated fixtures; refuses to start while production is busy
npm run test:live:headroom # real-engine output-headroom fitting
npm run check              # typecheck + every offline suite against your installed Pi
```

### Layout

| File | Role |
| --- | --- |
| `compaction.ts` | Extension entry: lifecycle, strategy selection, commands, tools, reports |
| `request-snapshot.ts` | Capture and validate the final wire request; provider adapter dispatch |
| `activation.ts`, `cache-outcome.ts` | Model qualification; measured cache-hit/miss feedback |
| `summary-verification.ts`, `review-queue.ts` | Evidence review prompts, verdict parsing, detached review state |
| `recall-archive.ts` | Bounded in-memory archive and read-only journal reader for recall |
| `summary-thinking.ts`, `summary-recovery.ts`, `normal-thinking-recovery.ts` | Summary thinking/limits; malformed-summary and thinking-only-turn recovery |
| `request-headroom.ts`, `provider-errors.ts` | Tokenizer-based output-headroom fitting; engine error classification |
| `compaction-report.ts`, `compaction-telemetry.ts` | Completion report measurement; metadata-only telemetry |
| `run-tests.mjs`, `integration-test.mjs`, `budget-integration.mjs`, … | Offline suites (see above) |

### Internal identifiers

Persisted identifiers all derive from the `/rcompact` command name: strategy
`rcompact`, entry types `rcompact-report` / `rcompact-review`, the
`telemetry/rcompact/` directory, and `rcompact.*` for the `Symbol.for` global
keys that share state (for example the finalization registry) between duplicate
module copies in one process while an upgrade and a stale copy collide during a
reload. These values are a storage contract — changing one stops previously
written records being recognised — so they are declared once in
[`identifiers.ts`](identifiers.ts) and a check in `identifiers.test.ts` fails if
runtime code hard-codes a persisted name elsewhere. The one user-visible name
kept for settings compatibility is the `betterCompaction` section and the `/bc`
command alias, both read by older configs; `better-compaction` and
`better-compaction-report` are registered for READ only so transcripts written
under that earlier name still render. Builds before 1.0.4 wrote identifiers with
a different prefix: those records stay on disk and in transcripts, but their
reports and reviews render as plain custom entries and a pre-existing checkpoint
is attributed to native compaction on the next run.

## Versioning

Semantic versioning, with `1.0.0` as the first public release (internal lineage 1.2.6 →
1.2.9 — see [CHANGELOG.md](CHANGELOG.md)). A tagged `vX.Y.Z` matches `package.json`;
`/rcompact` reports nothing about versions, so compare against `git describe`.

## License and attribution

MIT — see [LICENSE](LICENSE). The project's own lines are held by
`pi-rcompact contributors`; the upstream project this extension builds on keeps
its own copyright notice, and README credits it by name above.

Original BetterCompaction code: [NotSoSeriouss/BetterCompaction](https://github.com/NotSoSeriouss/BetterCompaction),
revision `5fa68e1d4ca6e18cede65af53584a8eb5298d35a` (MIT). Upstream's README is a good
read on the cache idea itself.
