# Change 001 — Initial implementation of `pi-jev-router-pro`

**Status:** proposed · **Constitution:** v1.0.0 · **Supersedes:** the installed
`pi-jev-model-router` + `pi-jev-model-router-profile-switcher` duo (retired after verification,
with operator confirmation).

## Why

Two extensions currently cooperate through a fragile file chain: the profile switcher serializes
a profile and **overwrites** `~/.pi/agent/pi-jev-model-router.json`, then forces the router to
reload. This couples them, races on write/reload, and makes "profile" a concept the router
itself does not understand. Additionally, the legacy router treats a mid-turn transient failure
(e.g. 429) as fail-visible-only: `isModelUnavailable()` (recovery.ts) explicitly rejects
429/5xx/rate-limit errors, so a dead provider mid-chain-of-thought just fails the turn.

pi ≥ 1.4 provides `pi.registerVirtualModel()`, whose `route(request, ctx)` hook runs before
**every** request and receives `reason: "retry"` with the failed request's model and error
message — the designed hook for per-attempt model fallback.

## What changes

One extension, one virtual model (`jev/auto`):

1. **Judgment routing** — port TypeSafe Jev classification and the tier/kind chain resolution
   (`routes`, `kindModels`, tiers `quick|standard|high|premium|xpremium`, free pool, adjacent
   tiers) into `route()`.
2. **Mid-turn transient fallback (new)** — on `reason: "retry"` with a transient error
   (429/5xx/529/rate-limit/network), advance the chain past the failed target; permanent
   failures (401/403, `model_not_found`, withdrawn) park the target with TTL and advance.
3. **Profiles as first-class data** — read `pi-jev-model-router-profiles.json` unchanged;
   switching is in-memory + extension state (no config rewrites, no reloads). Full
   `/jev profile …` CRUD port.
4. **Pre-flight eligibility** — parked set, Codex quota snapshots, budget caps, cache-aware
   tier moves: all ported and consulted inside `route()` before dispatch.
5. **Dormancy** — manual physical model selection is respected; the router re-activates on
   command or virtual-model selection.

## Goals

- Single npm/GitHub package `pi-jev-router-pro` installable via `pi install npm:pi-jev-router-pro`.
- Behavior-compatible routing with the legacy duo (same config shapes, same defaults: mode
  `auto`, budget soft/hard 0.7/0.9, cache deadband 0.25, free policy `prefer`).
- Deterministic fallback verified offline (unit tests + fault-injection flag) before any live
  smoke test.

## Non-goals (this change)

- No UI beyond pi's existing transcript/footer/widget surfaces.
- No new classifier features; Jev client is a port, not a rewrite.
- No multi-virtual-model profile exposure (one virtual model; profiles are state).

## Impact

- Replaces both legacy packages for this operator; both are removed **only after** the
  verification gate (§12 of the constitution) is green and the operator confirms.
- Session selection becomes `jev/auto` (physical dispatch recorded per assistant message, so
  replay and cost accounting stay correct).

## Operational notes (from operator — binding)

1. **Reference implementation:** `~/Documents/projects/me/pi-jev-model-router-profile-switcher/`
   is the operator's prior project — consult its `src/` (commands, storage, runtime, shared) and
   `tests/` before rewriting anything; port, don't reinvent.
2. **npm publish:** `.env` in that repo holds `NPM_TOKEN`. Publish by loading the token into the
   environment in the same shell invocation as `npm publish` (never echo, never commit).
3. **GitHub repo:** create the public repo `pi-jev-router-pro` with `gh` CLI
   (authenticated as `01Joseph-Hwang10`, `repo` scope confirmed) and push the initial commit.
4. **Finish line:** publish → `pi install npm:pi-jev-router-pro` → verify per `tasks.md`
   verification section → then, and only then, the operator may remove
   `pi-jev-model-router-profile-switcher` and `pi-jev-model-router`.
5. **Typesafe API key:** available as `TYPESAFE_API_KEY` in `~/.pi/.env` (the router's default
   `apiKeyEnv`). Do not copy it anywhere; reference the env name.
