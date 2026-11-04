# Constitution — pi-jev-router-pro

**Version:** 1.0.0 · **Ratified:** 2026-02-14 · **Applies to:** every change under `specs/changes/`

This document is the governing standard for the `pi-jev-router-pro` pi extension. Every change
proposal, design, and task list MUST cite the articles it satisfies. Amendments follow the
process in §13.

---

## 1. Purpose

`pi-jev-router-pro` is a single pi extension that merges and supersedes:

- `pi-jev-model-router` — TypeSafe Jev judgment-based tier routing (`routes` / `kindModels`),
- `pi-jev-model-router-profile-switcher` — routing profile CRUD and switching.

It routes every model request through **one virtual model** (`jev/auto` by default), dispatching
each request to a physical `{model, thinkingLevel}` pair chosen by a Jev typed judgment, an
ordered candidate chain, and an eligibility filter (parking, quota, budget).

## 2. Single routing surface (the virtual model)

- The extension MUST route exclusively via `pi.registerVirtualModel()`. It MUST NOT hijack the
  session model per prompt via the `input` hook (the legacy mechanism).
- The virtual model selection is stable for the session; only `route()` dispatch varies.
- A manual selection of a physical model by the user MUST be respected: the router goes dormant
  (no routing, no notifications) until the virtual model is selected again or re-activated by
  command.

## 3. Judgment-driven, visible decisions

- Every dispatch under `reason: "user"` MUST trace to a Jev typed judgment (kind, tier,
  complexity, capability, reasoning need).
- Every routing decision MUST be visible: transcript entries (`pi.appendEntry`) with renderer,
  footer/status-line dispatch display, and expandable judgment details.
- The router MUST NOT invent models: tiers or kinds with no configured chain are skipped with a
  warning, never guessed.

## 4. Chains are ordered; eligibility is fail-open

- Every `routes[tier]` and `kindModels[kind]` value is an **ordered candidate chain**: the first
  target that resolves to a known, credentialed, eligible model wins.
- Eligibility checks (parked, quota snapshot, budget) are pre-flight and **fail open**: unknown
  state admits the target, known ineligibility skips it (with a note).
- Chains resolve in order: free pool (per `free.policy`) → kind specialists → the selected
  tier's chain → adjacent tiers (nearest first: −1, +1, −2, +2 …).

## 5. Resilience: transient errors fall forward, permanent errors park

- A **transient** failure (HTTP 429, 5xx, 529 overload, rate-limit, network timeout) on a
  retried request MUST advance the chain past the failed target — this is the mid-turn,
  mid-chain-of-thought fallback (pi re-invokes `route()` with `reason: "retry"` and
  `request.failed` per attempt, up to `retry.maxRetries`).
- A **permanent** failure (401/403 auth, `model_not_found`, decommissioned/retired/withdrawn)
  MUST park the target (persisted, TTL `recovery.parkMs`, default 1h) so it is skipped
  pre-flight on later turns.
- Context overflow MUST NOT be treated as either: stay sticky and let pi's compaction recovery
  handle it.
- When the whole chain is exhausted, the router MUST throw from `route()`, ending the request
  with the error **visible**. Silent degradation is forbidden.

## 6. Cache and thinking continuity

- `reason: "continuation"` (tool follow-ups, extension messages) MUST stay sticky on
  `request.previous` unless it is ineligible or the judgment demands a different tier.
- Model switches are allowed only for: judgment change at a `user` boundary, transient failure
  fallback, or parked/quota/budget ineligibility. The cache penalty of avoidable switches MUST
  be estimated before moving tiers (`cache.aware`, `deadband`, ported from legacy).

## 7. Budget and quota ceilings

- Daily/monthly caps (`budget.dailyUsd/monthlyUsd`, soft 0.7 / hard 0.9 ratios by default)
  downgrade tiers automatically; a hard-cap breach MUST stop submission to ineligible models
  rather than overspend (opt-in quota protection, ported).
- Codex-style quota snapshot polling is ported; stale/unknown quota admits the target (fail
  open, note attached) unless `onUnknown` says otherwise.

## 8. Profiles are data; switching is memory

- Profiles (shape-compatible with `pi-jev-model-router-profiles.json`) are the routing
  configuration units. The active profile is in-memory + one extension state file.
- Profile switching MUST NOT rewrite another extension's config file and MUST NOT require a
  reload to take effect. Writes go only to: the profiles file (CRUD commands) and the
  extension's own state files.
- The legacy `pi-jev-model-router.json` MAY be imported as an implicit `default` profile and is
  otherwise read-only to this extension.

## 9. Consent modes

- `mode: "auto" | "confirm" | "notify"` is preserved. `confirm` prompts before risky switches
  (tier jumps and fallbacks when configured); `notify` never switches, only informs.
- All notifications are warnings-level or info-level; the router never blocks input silently.

## 10. Secrets and safety

- Secrets are referenced, never stored or logged: `apiKeyEnv` (default `TYPESAFE_API_KEY`),
  `endpointEnv` (default `TYPESAFE_API_URL`). `.env` files MUST be gitignored.
- Publishing uses `NPM_TOKEN` sourced from an existing local `.env` at publish time; tokens are
  never echoed, committed, or written to tracked files.
- No code in this project may execute against remote systems except: Jev classification calls,
  routed model requests through the user's own configured providers, and explicitly instructed
  publish/verification steps.

## 11. Compatibility

- Config shapes (`routes`, `kindModels`, tiers `quick|standard|high|premium|xpremium`,
  `RouteTarget {provider, model, thinkingLevel?, minTier?, priority?}`, `free`, `budget`,
  `cache`, `confirm`, `recovery`) MUST remain compatible with the legacy router's schema.
- With `useDefaultModels: false`, built-ins are gone entirely (no base, no fallback), matching
  legacy semantics; unconfigured tiers/kinds are skipped.
- New knobs MUST be optional and default to legacy-equivalent behavior.

## 12. Verification gates

- `pnpm typecheck` and `pnpm test` (vitest) MUST pass before any publish.
- Every capability requirement in a change's `spec.md` MUST have at least one scenario, and
  every scenario a verification method (unit test or documented live smoke step).
- Publish is only allowed after: green gates → `npm publish` → local install
  (`pi install npm:pi-jev-router-pro`) → live smoke checklist green.

## 13. Governance

- Changes live in `specs/changes/NNN--kebab-slug/` and contain `proposal.md`, `design.md`,
  `spec.md`, `tasks.md`. Work proceeds proposal → design → spec → tasks → implementation.
- A change MUST list the constitution articles it touches; conflicts require a constitution
  amendment (version bump + changelog note in this file) in the same change.
- Superseded legacy packages (`pi-jev-model-router`, `pi-jev-model-router-profile-switcher`)
  MUST NOT be removed until the superseding change's verification gate is green **and** the
  operator confirms removal.

## Amendment log

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-02-14 | Initial ratification with change `001--initial-implementation`. |
