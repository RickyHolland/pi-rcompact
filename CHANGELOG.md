# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`1.0.0` is the first public release. It corresponds to the internally developed build
recorded as 1.2.6 → 1.2.9; that lineage is reproduced below so behaviour changes stay
traceable, and future releases are versioned from here.

## [Unreleased]

### Added
- Nothing yet.

### Planned
- Configurable engine capability list, so the reasoning-budget bound, output-headroom
  fitting and engine-specific error classification can be enabled for any local engine
  instead of the built-in `sushi` / `splash` / `omlx` provider ids
  ([#1](https://github.com/RickyHolland/pi-rcompact/issues/1)).

## [1.0.4] - 2026-10-16

### Changed
- The evidence-review sentinel sent in the verification prompt reads `RCOMPACT EVIDENCE REVIEW`
  instead of carrying the original project name into every request. It is a prompt marker, not a
  persisted key, so nothing on disk changes meaning.
- Integration suites now read the sentinel from `summary-verification.ts` through
  `test-marker.mjs` rather than repeating the literal, so they cannot drift from the code. The
  match stays exact on purpose: the revision ask also mentions an "EVIDENCE REVIEW", and a
  looser substring would misclassify that request.
- The persisted identifiers themselves are now derived from the command name: strategy
  `rcompact`, entry types `rcompact-report` / `rcompact-review`, telemetry directory
  `telemetry/rcompact/`, and `rcompact.*` for the versioned global `Symbol.for` keys. They are
  declared once in `identifiers.ts`, and a check in `identifiers.test.ts` fails if a runtime
  source hard-codes a persisted identifier instead of importing it. Earlier notes in this file
  that described the old names were reworded rather than rewritten, so the rename is recorded
  here and nowhere else.
  **Upgrading effect:** records written by earlier builds stay on disk and in transcripts but are
  no longer recognised by name — their reports and reviews render as plain custom entries, a
  checkpoint created before the rename is attributed to native compaction on the next run, and
  older telemetry remains in the previous directory (nothing reads it back). The `betterCompaction`
  settings section, the `/bc` alias, and reading the earlier `better-compaction` strategy and
  `better-compaction-report` entry type all stay compatible.
- Temp-directory prefixes in the live/upgrade suites renamed to `rcompact-*`.
- The project-side copyright line in `LICENSE` now reads
  `Copyright (c) 2026 pi-rcompact contributors`. The upstream project's own notice is
  unchanged, and README still credits that project by name in the section above.

### Fixed
- `.github/workflows/codeql.yml` now pins both `codeql-action/init` and
  `codeql-action/analyze` to the same commit (`24c54180a607b1449ed407dd24f251e4e9147c8d`,
  tagged `v4.38.3`), and `.github/dependabot.yml` groups every `github/codeql-action`
  path into one update so they cannot drift to different majors again. Mixed majors across
  those two steps break CodeQL analysis.

### Documentation
- README's internal-identifiers note explains the storage contract: these values are written
  into session files, entry types and paths, so they are declared once in `identifiers.ts` and
  guarded by a test. It also records why the versioned `Symbol.for` keys must match across
  duplicate module copies inside one process — which is what an upgrade colliding with a stale
  copy needs.

## [1.0.3] - 2026-10-16

Documentation only — no code change.

### Changed
- SECURITY.md states the branch-protection guarantee that was actually obtained, replacing the
  1.0.2 wording. `main` now requires a merged pull request whose CI passed, enforced for the
  maintainer too, and a probe direct push was rejected by the server (`protected branch hook
  declined`). Blocking direct pushes is `Require a pull request before merging` with the
  approving-review count left at 0 — which is what makes it survivable for a solo maintainer:
  no second reviewer is needed, but an unreleased commit cannot land.
- Pinning a release tag is still the recommendation, restated on accurate grounds: passing
  checks is not the same promise as being released, and a tag plus the SHA in its release notes
  identifies exactly what you installed.

## [1.0.2] - 2026-10-16

Documentation accuracy and packaging only — no code change.

### Fixed
- SECURITY.md said the protected `main` "cannot receive an unverified commit". That overstated
  it: requiring status checks for admins blocks *merges* that fail CI, but on a user-owned
  repository nothing in classic branch protection stops an admin pushing commits straight to
  `main`. The section now says which guarantee applies where, and names that gap as the reason
  to pin a release tag instead of following the branch.
- `SECURITY.md` was missing from the package `files` list, so an installed copy did not ship the
  policy that the install instructions point you at.

## [1.0.1] - 2026-10-16

Security audit follow-up. No change to compaction behaviour; the fixes are in how settings
are saved, what ships in the package, and how the toolchain is pinned.

### Fixed
- **Config saves are atomic.** `/rcompact` setting changes wrote `settings.json` with a plain
  `writeFileSync`, so an interrupted write (disk full, crash, signal) could leave a truncated
  file — which Pi then reads as "no settings", silently switching compaction and every
  preference off. Writes now stage a sibling temp file and `rename` it into place, keeping the
  previous bytes in `<settings>.bak`.
- **Telemetry reported a stale version.** Records carried a hard-coded `1.2.8` from before the
  public release, so diagnostics pointed at a build that does not exist publicly. There is now
  one `VERSION` constant shared with `package.json`, guarded by a test.
- **`/rcompact check` was broken in an installed package.** `compatibility-check.mjs` is
  executed by the extension but was missing from the package `files` allow-list, so it was
  absent from a tarball install.

### Added
- `atomic-write.ts`, shared by config saves and telemetry, with tests for no staging debris,
  one-generation backup, preservation of the existing file mode, and a target left intact when
  the rename fails.
- CodeQL scanning of the extension's TypeScript and of the workflow files. It is deliberately
  not a required status check; CI remains the gate.

### Changed
- `actions/checkout`, `actions/setup-node` and `github/codeql-action` are pinned to full commit
  SHAs (version kept in a trailing comment for Dependabot to update). Tags are mutable refs in
  another repository.
- README documents a pinned install (`@v1.0.1`) as the default form, and SECURITY.md now
  discloses the loopback tokenizer preflight, which sends the rendered prompt to your own
  provider port.

## [1.0.0] - 2026-10-16

First public release: cache-aware compaction for Pi with evidence review, opt-in recall,
output-headroom fitting, bounded recovery and metadata-only telemetry.

### Added
- **Captured-request compaction.** The summary is requested on the exact final
  OpenAI-compatible payload of the last successful ordinary request — after every context
  and payload hook, in either hook order — so the engine's prefix cache is reused. Any
  loopback OpenAI-compatible provider qualifies; everything else keeps the
  serialized-prefix path, and unsafe or missing captures yield to Pi native with a reason.
- **Measured cache-miss feedback.** A captured ask reporting zero cache read on a prompt
  of at least `cacheMissMinPromptTokens` (default 2048) counts as one measured miss and
  hands exactly the next compaction to Pi native (five after three consecutive misses);
  one measured hit clears the streak. Unmeasurable usage is recorded as `unmeasured` and
  can never disable the extension. Select with
  `/rcompact cachepolicy defer|keep|native`.
- **Evidence review.** Blocking review verifies each draft summary against the same
  filtered source, revises once after rejection and retains history on a second failure.
  Background review applies a valid summary immediately and reviews at the next idle
  boundary, turning a rejection into a durable warning for the next model turn.
  `/rcompact verify blocking|background|off`.
- **Recall over the replaced transcript** (off by default): `recall_before_compaction`
  and `recall_generations` search the filtered request view of earlier compactions, or Pi's
  session journal under the second, explicit `recallJournal: "stored"` opt-in. Read-only,
  in-memory by default, bounded by generation and byte caps, with reasoning never
  surfaced as evidence.
- **Final-request output headroom.** Text requests to local tokenizer-capable engines are
  counted through their own `/apply-template` and `/tokenize` endpoints after other
  extensions' hooks (no inference) and the output limit is lowered only when needed to fit
  the remaining context. Multimodal and older-engine requests keep provider validation.
- **Bounded recovery.** Invalid, empty, truncated or thinking-only summaries are retried
  once with a zero-thinking generation budget; local prefill-capacity refusals get one
  fresh-prefix attempt; a successful local turn that produced only reasoning gets one
  labelled continuation per user prompt. Nothing replays completed tool actions.
- **Model activation gate.** The long captured path is limited by default to models
  reporting zero input and zero cache-read price; `/rcompact models <glob>` overrides
  explicitly, `auto` restores the price gate.
- **Completion report and telemetry.** Post-compaction report (elapsed including retries
  and review, tokens before → after and saved, retained messages, summary cache reuse,
  review status) stored as a custom session entry, never sent to the model. Metadata-only
  telemetry under the extension's `telemetry/` subdirectory (renamed in 1.0.4, see above).
- **`/rcompact check`** runs typechecking, unit checks and real Pi SDK integration against
  the installed runtime, with isolated fake providers and no production writes.
- Development docs for contributors: README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT,
  issue and pull-request templates, Dependabot for actions and dev dependencies, and CI
  running typecheck plus the whole offline suite on a Node 22 / 24 matrix, with an advisory
  job that re-runs it against the newest published Pi.

### Changed
- Captured-path reasoning effort is mirrored from the ordinary request instead of
  requiring the configured compaction level to match, so a session running at medium
  thinking keeps its cache instead of falling back to native to satisfy a label.
  `thinking` still governs the serialized-prefix path; `thinking: "off"` remains a native
  fallback with an explicit reason.
- Screenshots no longer force an oversized-capture fallback: a capture keeps one immutable
  provider payload plus per-message digests instead of also retaining the effective
  context and canonical transcript.
- Recall archives only the final filtered wire request, so a pruned checkpoint or a
  redacted tool argument cannot resurrect withheld text or file paths.
- File-operation details in checkpoints are limited to paths present in the final filtered
  provider conversation.
- Package renamed for publication as `pi-rcompact` (`/rcompact`, with `/bc` retained as an
  alias). Persisted internal identifiers keep their original names for session-file and
  settings compatibility at the time: the strategy id, the report and review entry types, the
  settings section
  `betterCompaction`, and the telemetry subdirectory. The strategy id, entry types and telemetry
  directory were renamed in 1.0.4; `betterCompaction` still persists.

### Fixed
- Late hook results can no longer repopulate a retired snapshot; async hooks are fenced by
  request/session generations, reloads retire the previous adapter instead of stacking
  wrappers, and ambiguous simultaneous clients on one session id never capture.
- Reviews bind to the newest active checkpoint when Pi emits an older entry for identical
  summary text; abandoned background jobs are expired rather than marked passed.
- Source-fidelity tests that searched candidate-inclusive payloads confused quoted
  candidates with filtered source; they now inspect source messages only.
- Malformed usage reports are ignored when measuring cache misses instead of being read as
  a zero-cache miss.
- A temporarily unavailable or older tokenizer no longer blocks ordinary requests, and a
  rejected request is no longer replayed with its full tool loadout under the captured
  strategy.
- Pi 1.2 compatibility: `before_agent_start` fires for extension-triggered
  custom-message runs, so the one-recovery-per-user-prompt limit survives instead of
  renewing itself.

### Verified against
Pi 1.1.0 and Pi 1.2.0 locally, and the newest published Pi (1.3.0) in CI, where
`npm run typecheck` and the full offline suite also run on a Node 22 / 24 matrix;
143 unit checks plus real Pi SDK integration in both payload-hook orders, cancellation
and rollback, three reloads, frozen/shared runtime isolation, a runtime-reinstall
simulation, screenshot-heavy compaction, and a temporary loopback fixture provider
performing no real inference.

### Known limitations
- Prefix reuse depends on engine residency; misses are legitimate and are measured rather
  than assumed.
- Reasoning-budget, output-headroom and engine-error features are currently gated on the
  provider ids `sushi`, `splash` and `omlx`; on other engines they no-op.
- Evidence review is a second reading by the same model, not independent verification.
- No "preserve mode": a checkpoint edit invalidates the cached request, and the public SDK
  cannot replace an applied checkpoint for rollback (see [DESIGN.md](DESIGN.md)).
