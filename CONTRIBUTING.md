# Contributing to pi-rcompact

Thanks for taking an interest. This project is context compaction for Pi, and it runs
against a live agent's transcript, so the bar for changes is "never lose the user's
history" rather than "looked good in a demo".

## What I'm looking for

- Bug fixes, especially fallback correctness: any path that could summarize a request the
  agent no longer sees, resurrect redacted text, or apply an invalid checkpoint.
- Compatibility work for new Pi SDK releases, and tests that prove a fallback stays a
  fallback.
- Generalizing engine-specific behavior behind explicit configuration (the
  `sushi` / `splash` / `omlx` gates listed in README *Known limitations*) is the highest-value
  open work and already scoped: [#1](https://github.com/RickyHolland/pi-rcompact/issues/1).
- Documentation, examples, and clearer error/fallback reasons.
- Test coverage for behavior that is currently only checked by one integration scenario.

## What probably won't be merged

- Changes that make compaction lossy or silent: applying an unverified/invalid summary,
  rewriting history while reusing a stale capture, or defaulting any opt-in on.
- Anything that sends prompt content, summaries, tool arguments or file paths to a new
  destination — telemetry is metadata-only by design and a security property, not a tuning
  knob.
- Large refactors of `compaction.ts` without a behavior story. It is one big file
  deliberately-ish: the entry point holds the capture/apply/retry state machine, and I would
  rather review a real decomposition than accept churn that only moves lines.
- Prompt rewrites that are not evaluated against real transcripts. Summary quality claims
  need evidence, not vibes.

## Setup

Requires Node ≥ 22.19 (Pi's own floor) and an installed Pi runtime, because the suite drives
the real SDK instead of a mock.

```sh
npm install --ignore-scripts --legacy-peer-deps   # pinned dev deps only; Pi is a peer
npm run typecheck
npm test
```

Prefer `npm ci` once the repo is cloned: it installs exactly what the lockfile pins. With
`--legacy-peer-deps`, npm resolves peers differently and rewrites `package-lock.json` to drop
the Pi peer tree — that rebuild is what CI runs on, so commit it deliberately rather than
accidentally on every install.

`npm test` is offline and self-contained: 143 unit checks plus real Pi SDK integration in
both payload-hook orders, all against a temporary loopback fixture provider. It performs no
inference and writes only to temp directories. If Pi runtime discovery fails, point it
explicitly:

```sh
PI_TEST_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent npm test
```

Useful extras:

| Command | What it does |
| --- | --- |
| `npm run test:unit` | Just the unit checks (fast loop) |
| `npm run check` | Typecheck plus every offline suite, as one compatibility verdict |
| `PI_MEMORY_EXTENSION=/path/to/extension.ts npm test` | Also load a third-party extension to prove the captured prefix survives a real extension stack |
| `npm run test:live` | Real local-engine inference with isolated fixtures. Requires an idle local engine; not run in CI |

## Making a change

1. Branch from `main`.
2. Add or adjust a test first when the change affects behavior. The harness auto-discovers
   any new `*.test.ts`, so it cannot silently sit unrun. For lifecycle changes, extend an
   integration script (`integration-test.mjs` / `budget-integration.mjs`) rather than only a
   unit test — the SDK path is where fallback bugs live.
3. Run `npm run typecheck && npm test`. Both must pass.
4. Update `CHANGELOG.md` under **Unreleased**, and README if user-visible behavior, commands
   or settings changed. Claims in docs must match shipped behavior; if a feature is
   engine-specific, say so.
5. One focused commit per logical change. Imperative subject, e.g.
   `fix: expire abandoned background reviews instead of marking them passed`.
6. Open a pull request. Describe the failure mode being prevented, not just the diff. If it
   changes summary quality or cache behavior, include before/after measurements.

## Reporting issues

Use the issue templates when you can. The most useful reports include: Pi version, model and
provider, `thinking` level, what `/rcompact` reported, the fallback reason shown (if any),
whether history was retained, and relevant lines from `telemetry/rcompact/` — those
files are metadata-only, so they are safe to attach. Please do not attach session
transcripts; they usually contain secrets.

For anything you would rather not post publicly, see [SECURITY.md](SECURITY.md).

## Ground rules

- Be direct about uncertainty. This project keeps a written record of diagnoses that turned
  out wrong; "the cause is unproven" is a valid and welcome sentence.
- Never push a claim of reliability or full coverage that your tests do not support.
- Don't force-push or rewrite `main`. Tags are releases; don't move them.
- By contributing you agree that your contributions are licensed under the MIT license in
  this repository, and you confirm you have the right to submit them.
