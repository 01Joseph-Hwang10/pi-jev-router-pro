# Change 003 — Merge-before-write persistence

**Status:** implemented · **Constitution:** v1.0.0 · **Articles touched:** §8 (still only our own
state files; no amendment needed).

## Why

`persistState()` blind-rewrote the state file from memory on every routed request. With several pi
sessions — multiple on one machine, or across Syncthing-synced machines — each session held a
stale snapshot, so the last writer silently dropped the others' ledger spend, parks, and profile
switches; a stale session could even resurrect an old profile over a newer switch. Change 002 made
startup self-heal conflict copies; this change fixes the writer side.

## What

- `persistState()` now re-reads the on-disk state and merges it (the change-002 max-merge: ledger
  by max per model, parks unioned, newest `lastSwitchedAt` wins) before writing. Per-runtime
  persists are serialized through a promise chain, so overlapping persists merge instead of racing.
- `saveActiveProfileName()` goes through the same read-merge-write: a switch owns the profile
  fields (stamped `lastSwitchedAt: now`, clears included) but never claims ledger knowledge.
- `saveProState()` writes atomically (temp + rename, same pattern as `fileParking`) so concurrent
  merge-reads never observe a half-written file.
- Merge tie-break: on equal `lastSwitchedAt`, a defined profile beats an unset one, so an empty or
  corrupt on-disk file cannot erase an incoming switch.
- The in-memory snapshot is still not adopted from disk during persists — a session's own routing
  changes only via explicit switches or reload.

## Verification

- `tests/switcher.test.ts`: a session that started before another session's persist keeps its
  spend; a stale session's persist does not revert another session's switch; overlapping persists
  serialize and merge.
- `tests/state-conflicts.test.ts`: disk spend + newer switch survive a merge-save; missing/corrupt
  disk degrades to empty with no `.tmp` leftovers; switch preserves the on-disk ledger.
- Full suite: 87 tests passing; `tsc --noEmit` clean.

## Known limits

Concurrent writers on disjoint machines can still both merge from the same disk base (TOCTOU);
Syncthing then records a conflict copy, which change 002 heals at the next session start. Same-key
ledger increments from a shared base remain conservative (max, not sum) — exact global accounting
would need per-device shards (candidate future change).
