<!--
Delete this comment. The failure mode being prevented matters more than the diff.
-->

## What this prevents

<!-- What went wrong before this change, in one or two sentences. If the cause is unproven, say so. -->

## Change

<!-- What you changed and why this shape. Point at the key lines if the diff is large. -->

## Safety properties touched

<!-- Tick what applies and explain the mechanism in one line each. -->

- [ ] Can change what gets applied as a checkpoint
- [ ] Can change what is retained when something fails
- [ ] Touches capture eligibility or invalidation
- [ ] Touches what recall or review can see (redaction/pruning)
- [ ] Touches telemetry contents
- [ ] None of the above

## Tests

```
npm run typecheck
npm test
```

- [ ] Both pass locally (Node ≥ 22.19, Pi runtime installed or `PI_TEST_ROOT` set)
- [ ] New/changed behavior is covered by a test — name it
- [ ] Lifecycle behavior is covered by an SDK integration suite, not only a unit test

<!-- If you have before/after numbers (cache read, compaction latency, summary tokens,
factual checks on real transcripts), put them here and say how you measured them.
Claims about quality need evidence. -->

## Docs

- [ ] `CHANGELOG.md` updated under **Unreleased**
- [ ] README updated if commands, settings, defaults or limitations changed
- [ ] Documentation claims match shipped behavior (including engine-specific gates)
