# Preserve-mode checkpoint design spike

Goal: fewer destructive summaries by adding a compact checkpoint at a safe turn boundary while retaining selected original evidence. This is a design spike, not a shipped context-rewrite mode.

## Observations from the current Pi SDK

The effective wire request may differ from session entries: context hooks and final payload hooks can prune, redact, replace or reorder evidence and tool schemas. Captured compaction is safe only after an ordinary request has successfully established a snapshot of that final request. Existing SDK tests demonstrate that context edits, branch changes, reasoning changes and discarded uncaptured messages invalidate a snapshot. `/reload` also clears it.

A checkpoint inserted via a context edit changes the model projection and invalidates the previously cached request. Reusing the old capture after that edit would either reintroduce discarded evidence or summarize a request the agent no longer sees. Retaining every original message avoids this inconsistency but does not reduce context usage, so it cannot postpone the hard context limit indefinitely.

## Candidate implementation

1. Only schedule after `agent_end`, when all tools and assistant output are settled.
2. Build a checkpoint against the same final filtered request and verify it before any history change.
3. Use a public Pi projection-edit API, preserving original evidence IDs and recording a reversible boundary.
4. Invalidate the old capture; wait for the next successful ordinary request before captured compaction.
5. Measure cache reuse, resulting context size, compaction frequency and factual fidelity against ordinary compaction.

## Decision

Do not ship a preserve-mode history rewrite yet. The current public SDK cannot replace an applied checkpoint for review rollback, and projection edits force snapshot invalidation. A prototype must first prove filtered-source fidelity across both hook orders, reload, branching and tool transitions, then demonstrate a net measured benefit. Background review is therefore advisory after application and makes rejection visible rather than pretending to rewind history.
