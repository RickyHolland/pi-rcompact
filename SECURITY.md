# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| Latest release on `main` and the most recent tag | ✅ |
| Older tags | ❌ (self-hosted: patch locally, and please tell me what broke) |

## Why this extension is security-relevant

rcompact sits between Pi and your model provider and handles two sensitive things:

1. **The exact final wire request** — the full conversation including tool results, held in
   session memory only and never written to disk. It also decides what a summary and an
   evidence review get to see, so a bug here can leak text that a context or payload hook
   deliberately redacted or pruned.
2. **Post-compaction recall** — opt-in access to transcript text that compaction removed. In
   the default `archive` mode this is the filtered request view; the second, explicit
   `stored` mode reads Pi's session journal, which holds original text and is therefore
   labelled `UNFILTERED` on every result.

Telemetry is designed to be safe to share: metadata only (lifecycle, trigger, model, timings,
retries, cache usage, token counts, retained-entry counts, estimated reduction). It must never
contain prompts, summaries, tool arguments, file paths, credentials or raw provider error
text. If you find that it does, that is a security bug.

## Local tokenizer preflight (loopback requests)

For output-headroom fitting, one code path asks a local engine to measure the request instead
of estimating it. Before a captured request, when **all** of these hold — the model's provider
is `splash`, its API is `openai-completions`, and its `baseUrl` is plain
`http://` on `127.0.0.1`, `localhost` or `[::1]` — rcompact makes:

| Request | Body |
| --- | --- |
| `GET <baseUrl>/status` | none (window size; cached 30 s) |
| `POST <baseUrl>/apply-template` | **the entire request payload, i.e. the whole rendered conversation** |
| `POST <baseUrl>/tokenize` | the rendered prompt string |

Guards: no credential-bearing URL is accepted (`url.username`/`url.password` reject),
non-loopback hosts and any `https`/other scheme skip the preflight entirely, redirects are
refused (`redirect: 'error'`), and the whole thing is fail-open — a timeout or error falls
back to estimating rather than blocking your turn.

The trust implication is deliberate and worth stating plainly: **whatever process owns that
port sees your full conversation text**, not just the token counts. That is the same data the
inference request itself carries, so the preflight does not widen what your provider can see —
it does mean a process that squats the port *before* your provider binds it (or a forwarded
port reachable from elsewhere on a shared machine) receives it. If that is a threat in your
environment, bind the engine to a port only you can use, or do not configure a `splash`
provider with a loopback `baseUrl`; the preflight is then skipped and compaction keeps working
by estimation.

## Repository security posture

Checked 2026-10-16, and the reason a pinned install is a reasonable thing to trust:

- `main` can only be updated through a merged pull request, and the CI suite (typecheck +
  offline unit checks + real-SDK integration on Node 22 and 24) has to pass on it — enforced for
  the maintainer as well, so a change cannot be merged past a failing suite by whoever wrote it.
  This is verified rather than assumed: a probe direct push on 2026-10-16 was rejected by the
  server with "Changes must be made through a pull request" (`! [remote rejected] main -> main
  (protected branch hook declined)`). Every commit on `main` has a green suite attached to it.
- Force-push and branch deletion are blocked, and released `v*` tags cannot be deleted.
- Pinning a tag is still the recommended form, for a different reason than CI: passing checks is
  not the same as being *released*. A tag names the exact commit the release notes describe, and
  those notes carry its SHA — because moving a tag (unlike deleting one) cannot be blocked on
  this plan.
- Actions are pinned to commit SHAs; the CI workflow has no `${{ }}` interpolation inside a
  shell step and no `pull_request_target`; its token is scoped to `contents: read`.
- The package has **no runtime dependencies**, and the lockfile has no install scripts, so
  neither `pi install` nor `npm ci` runs third-party lifecycle code.
- Dependabot vulnerability alerts and security updates are enabled, as is secret scanning with
  push protection.

## Reporting a vulnerability

Please report privately rather than opening a public issue, especially if a proof of concept
would demonstrate a redaction bypass or transcript exposure.

- **Preferred:** use GitHub's [private vulnerability reporting](https://github.com/RickyHolland/pi-rcompact/security/advisories/new)
  on this repository — it is enabled, so the link opens a private advisory form. If that is
  unavailable to you, contact the maintainer through their GitHub profile.
- Include: version or commit, Pi version, provider/model, the setting values involved, and
  steps to reproduce. Do **not** attach a session transcript — reproduce with a fixture if you
  can.

I aim to acknowledge within 3 business days and to ship a fix or a documented mitigation
within 14. I will credit reporters who want it, and I will not require an NDA.

## Scope notes

- **Out of scope:** anything requiring you to enable an explicit opt-in that is documented as
  reducing privacy (`recallJournal: "stored"`, which surfaces unfiltered journal text) — that
  behaviour is the documented trade-off, not a flaw.
- **Out of scope:** prompt-cache misses, summary quality regressions, and provider-side
  behaviour. These are correctness/quality issues — please open a normal issue.
- **Trust boundary:** rcompact is third-party extension code that runs with your Pi
  extension privileges. Review the source before installing, as Pi's own documentation
  advises for any package.
