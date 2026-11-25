# Change 002 — Self-healing merge of sync-conflict state copies

**Status:** implemented · **Constitution:** v1.0.0 · **Articles touched:** §8 (only our own state
files are read, merged, and deleted; no amendment needed).

## Why

The pro state file (`pi-jev-router-pro-state.json`) syncs across machines. Two devices writing it
while offline from each other leave `<state-file>.sync-conflict-<timestamp>-<device>.json` losers
behind, and the loser can hold ledger spend the winner never saw (observed: 2026-11-19 and
2026-11-23 daily totals regressed after a conflict resolved as last-writer-wins). Conflict copies
also piled up in the agent directory (8 copies over one week).

## What

- `loadProState` now reconciles conflict copies of its own state file after loading: ledgers merge
  by max per model key (total recomputed as the sum of `byModel`, the `recordCost` invariant; jev
  counters maxed — conservative so budget caps are never over-reported), parks union by key with
  the latest `until`, and the newest `lastSwitchedAt` decides `activeProfile`.
- The merged state is persisted before the copies are deleted; a failed persist keeps the copies
  for the next load. Unreadable copies are deleted (no recoverable data). Healing is best-effort:
  any failure falls back to the plain loaded state and never breaks routing.
- Copies of *other* files are never touched.

## Verification

- `tests/state-conflicts.test.ts`: recovery of losing-copy spend, day/park union + newest-switch
  precedence, corrupt-copy cleanup, non-matching prefixes ignored.
- Full suite: 81 tests passing; `tsc --noEmit` clean.
