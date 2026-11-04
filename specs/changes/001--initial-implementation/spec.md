# Spec — Change 001

Constitution: v1.0.0. Every requirement cites articles; every scenario names a verification
method (unit test = **UT**, live smoke step = **SM**, documented inspection = **DI**).

## R1 — Virtual model surface (constitution §2)

The extension registers exactly one virtual model (default `jev/auto`) and never mutates the
session model per prompt.

- **R1.1** Selecting `jev/auto` exposes selectable thinking levels `low|medium|high|xhigh`.
  — SM: `/model` lists it with levels.
- **R1.2** Session start auto-selects the virtual model when enabled; a manual physical-model
  selection sets dormancy (one warning, no routing); `/jev auto` re-activates.
  — UT: dormancy state machine; SM: select physical model → status shows `dormant`.
- **R1.3** While dormant, no notifications, entries, or routing occur.
  — UT; SM: physical-model turn produces no `jev-router` entries.

## R2 — Judgment routing at `user` boundaries (§3, §4)

- **R2.1** First request after a user message dispatches to the first eligible entry of:
  free pool (per policy) → kind specialists (`minTier` ≤ tier, `priority` desc) →
  `routes[tier]` → adjacent tiers nearest-first. — UT: golden chain tables incl. `xpremium`.
- **R2.2** Every decision appends a transcript entry with: action glyph, tier, dispatched
  `provider/model`, judgment summary (kind, complexity, capability, reasoning, budget) —
  expandable to raw judgment. — UT: entry payload; SM: expand entry.
- **R2.3** Jev unavailable (missing key, timeout) → warn + sticky dispatch
  (`previous ?? chain[0]`); turn is never blocked. — UT.
- **R2.4** Unconfigured tier/kind (`useDefaultModels: false`) → skipped with warning; never an
  invented model. — UT.

## R3 — Sticky continuation (§6)

- **R3.1** Tool follow-ups and extension-message continuations reuse `request.previous` when
  eligible. — UT.
- **R3.2** Judgment-driven tier changes at `user` boundaries respect cache deadband: an
  avoidable switch within `cache.deadband` (default 0.25 penalty ratio) is suppressed.
  — UT.

## R4 — Transient fallback on retry (§5) — *the headline capability*

- **R4.1** `reason: "retry"` + transient error (429/5xx/529/rate-limit/timeout in
  `failed.message`) → dispatch the next untried eligible chain entry. — UT.
- **R4.2** Each further retry advances further; `state.attempted` grows monotonically; a
  `user` boundary resets it. — UT.
- **R4.3** Works mid-chain-of-thought (after tool results) — pi starts a fresh run per retry,
  context intact; no extension-side `toolsRan` guard. — UT (decision table); SM (fault
  injection after tool calls).
- **R4.4** Chain exhausted → `route()` throws; the run ends with the original error visible;
  no silent degrade, exactly one throw per exhaustion. — UT; SM: chain of one dead target.
- **R4.5** Context-overflow failures are **not** fallback triggers: sticky `previous`; pi
  compaction recovery proceeds. — UT.

## R5 — Permanent failure parking (§5)

- **R5.1** 401/403, `model_not_found`, decommissioned/retired/withdrawn → target parked for
  `recovery.parkMs` (default 3 600 000), persisted to disk, skipped pre-flight on later turns
  and sessions until expiry. — UT: TTL round-trip; SM: `/jev-router` lists parking.
- **R5.2** Parking requires the failed model's identity in the error text (port
  `isModelUnavailable` guard: no bare status parking without identity). — UT.

## R6 — Pre-flight eligibility (§4, §7)

- **R6.1** Quota snapshot below floor → skip with note; unknown/stale snapshot → admit with
  note (`onUnknown` honored). — UT.
- **R6.2** Budget: soft breach (0.7) suggests one tier down; hard breach (0.9) stops
  submission to higher tiers. — UT.
- **R6.3** All notes surface in the decision entry. — UT.

## R7 — Direct requests (§3 table)

- **R7.1** Compaction summaries / `streamSimple()` dispatch the cheapest healthy target; no
  router-state writes. — UT.

## R8 — Profiles & switching (§8, §9)

- **R8.1** Reads legacy `pi-jev-model-router-profiles.json` unchanged (e.g. keys `google`,
  `zai-coding-cn`); profile = superset of legacy router config. — UT: round-trip operator's
  real file structure.
- **R8.2** `/jev profile switch` swaps chains in-memory, persists only the active-profile name
  to `pi-jev-router-pro-state.json`, takes effect on the next request, never rewrites legacy
  config, never reloads. — UT; SM: switch mid-session → next dispatch differs.
- **R8.3** Full CRUD port: add/clone/edit/save/show/current/remove/list (+ legacy
  `/jev-profile*` aliases), with confirmation guards on destructive ops. — UT; SM each.
- **R8.4** Status-bar widget shows `jev-pro: <profile>` and last dispatch. — SM.
- **R8.5** Account-switcher awareness: `/jev profile list` shows provider account status
  (read-only reporting port). — UT (mocked statuses); SM.

## R9 — Legacy compatibility & migration (§11)

- **R9.1** Legacy `pi-jev-model-router.json` importable as implicit `default` profile on first
  run (read-only to this extension). — UT.
- **R9.2** Env knobs preserved: `JEV_ROUTER_MODE`, `JEV_ROUTER_OFF`, `TYPESAFE_API_KEY`,
  `TYPESAFE_API_URL`. — UT.
- **R9.3** When a legacy router is also installed, session start warns once about duplicate
  routing surfaces. — UT; SM.

## R10 — Consent modes (§9)

- **R10.1** `confirm` mode prompts on tier jumps and on fallback switches per
  `confirm.tiers`/timeout policy; `notify` never switches (dispatch = current model, notify
  only); `auto` switches silently. — UT.

## R11 — Packaging, publish, retirement (§10, §12)

- **R11.1** `pnpm typecheck` + `pnpm test` green before publish. — DI (CI-less gate in tasks).
- **R11.2** Public GitHub repo `01Joseph-Hwang10/pi-jev-router-pro`; npm `pi-jev-router-pro`;
  `pi install npm:pi-jev-router-pro` works. — SM.
- **R11.3** Secrets: no token/key values in repo, logs, or tracked files; `.env` gitignored.
  — DI.
- **R11.4** Legacy packages removed only after R11.2 green **and** operator confirmation. — DI.
