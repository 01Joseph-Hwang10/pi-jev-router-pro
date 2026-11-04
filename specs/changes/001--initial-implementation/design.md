# Design — Change 001

Constitution: v1.0.0. Articles touched: 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 (all satisfied; no
amendments needed).

## 1. Architecture

```
pi-jev-router-pro/
├── package.json          # "pi": { "extensions": ["./src/index.ts"] }, peerDep pi-coding-agent >=1.4.0
├── tsconfig.json         # port from profile-switcher
├── vitest.config.ts
├── src/
│   ├── index.ts          # extension factory: registers virtual model, tools, commands, widgets
│   ├── domain/
│   │   ├── types.ts      # Tier, RouteTarget, JevProfile, ProConfig (port + additions)
│   │   ├── chain.ts      # chain building + firstEligible() (port of router.decide ordering)
│   │   └── errors.ts     # transient/permanent/overflow classification (isTransientFailure())
│   ├── jev/
│   │   ├── client.ts     # port of jev.ts (classifyRequest, buildQuestions, buildState)
│   │   └── config.ts     # port of config.ts defaults: TYPESAFE_API_KEY / TYPESAFE_API_URL / jev-latest
│   ├── routing/
│   │   ├── router.ts     # route(request, ctx): decision table below
│   │   ├── parking.ts    # port of recovery.ts Parking (provider/model → until, persisted)
│   │   ├── quota.ts      # port of quota.ts (Codex snapshot polling, eligibility)
│   │   └── budget.ts     # port of budget.ts (tier downgrade, caps)
│   ├── profiles/
│   │   ├── store.ts      # profiles file IO (shape-compatible; write-only-when-CRUD)
│   │   ├── switcher.ts   # active profile = memory + state file (no legacy rewrite, no reload)
│   │   └── accounts.ts   # port account-switcher awareness (status reporting only)
│   ├── commands/         # /jev … command surface (see §5)
│   ├── ui/
│   │   ├── entries.ts    # decision entries via pi.appendEntry + renderers
│   │   └── status.ts     # status-bar widget (profile + last dispatch)
│   └── storage/
│       └── paths.ts      # ~/.pi/agent/pi-jev-router-pro{,-profiles,-state,-quota}.json (+ legacy reads)
└── tests/                # vitest: chain, errors, parking, quota, budget, profiles, router table
```

## 2. Virtual model registration

```ts
pi.registerVirtualModel<RouterState>({
  provider: cfg.virtual.provider ?? "jev",
  id: cfg.virtual.id ?? "auto",
  name: "Auto (Jev Pro)",
  thinkingLevels: ["low", "medium", "high", "xhigh"],
  route(request, ctx) { /* §3 */ },
});
```

- `thinkingLevels` are router inputs, clamped per dispatched physical model by pi.
- `contextWindow`/`maxTokens` unset (unknown until first response — pi uses the dispatched
  model's limits thereafter, as documented in virtual-models.md).
- Dormancy (constitution §2): a `session_start` handler selects `jev/auto` when
  `cfg.enabled && cfg.mode !== "off"`; a `model_select` handler detects a manual physical-model
  selection → set `dormant: true`, notify once; `/jev auto` re-selects and clears dormancy.
  While dormant, `route()` is never invoked by pi (the virtual model isn't selected).

## 3. `route()` decision table

| reason | behavior |
|---|---|
| `user` | Jev classify (cached per prompt text, TTL 60s) → tier + kind. Build chain: free pool (policy) → `kindCandidates(kind, tier)` → `routes[tier]` → adjacent tiers (−1, +1, −2, +2…). Return first eligible target (parked/quota/budget filter). Cache miss/Jev error → warn, return `previous ?? chain[0]` (fail-open, constitution §4). |
| `continuation` | `request.previous` if it is still eligible → return it (cache/thinking warmth, constitution §6). Else re-resolve like `user` **without** re-classifying (reuse `state.lastJudgment`). |
| `retry` | Classify `request.failed.message`: **transient** (429, 5xx, 529, rate-limit, timeout regex) → advance chain past `failed.model`, skipping `state.attempted`; **permanent** (401/403, model_not_found, decommissioned/retired/withdrawn — port `isModelUnavailable` regex) → `parking.park(key, parkMs)` then advance; **context overflow** → return `previous` (pi compaction recovery owns it). Chain exhausted → `throw new JevChainExhausted(attempts)` (visible failure, constitution §5). |
| `direct` | Compaction/summaries and `streamSimple()` calls: cheapest healthy target (`directModel` config or first eligible of the `quick` chain). No state writes (pi ignores state for direct). |

Chain advance = next untried eligible entry of the **built chain** (already includes adjacent
tiers), tracked via `state.attempted` (JSON array of `provider/model`). pi retries up to
`retry.maxRetries` (default 3) → ≤ 4 physical attempts per turn; leftovers converge on later
turns via parking/pre-flight skip.

Router state (`RouterState`, JSON per branch): `{ attempted?: string[], lastJudgment?,
lastTier?: Tier }`. Parking persists to disk (survives sessions), state does not grow
unboundedly (attempted resets on every `user` reason).

## 4. Eligibility (pre-flight, fail-open)

Port order preserved from legacy `firstAvailable()` + `eligibleTarget()`:

1. Model exists in `ctx.modelRegistry` catalog and provider has credentials.
2. Not parked (`parking.has(key)`), else note `skipped: parked until <iso>`.
3. Quota snapshot allows (Codex polling; `onUnknown: admit | skip`, unknown ⇒ admit + note).
4. Budget allows (soft → one-tier-down hint; hard ⇒ skip tier chain upward).

## 5. Commands (port + merge)

Legacy switcher commands are re-issued under the `/jev` namespace, keeping old aliases working:

| Command | Behavior |
|---|---|
| `/jev profile list`, `/jev-profiles` | Fuzzy list with active marker + provider badges. |
| `/jev profile switch <name>` / `/jev-profile <name>` | Swap in-memory chain; persist active name to `pi-jev-router-pro-state.json`; status widget updates. **No file rewrite of legacy config; no reload.** |
| `/jev profile add \| clone \| edit \| save \| show \| current \| remove` + aliases | Port CRUD from `profile-switcher/src/commands/*` (editors, confirmations). |
| `/jev auto` | Re-activate routing (select virtual model). |
| `/jev-router` | Status: mode, active profile, tier chains, parking list, budget/quota state, built-in models on/off. |
| `/jev-route <text>` | Classify preview (no switch); also registered as model-callable tool `jev_route` (port). |

## 6. Config loading order

1. Profiles file `~/.pi/agent/pi-jev-model-router-profiles.json` (legacy name kept; override via
   `JEV_ROUTER_PROFILES` env or `profilesPath` in pro config).
2. Active profile name from `pi-jev-router-pro-state.json`; **fallback:** legacy
   `pi-jev-model-router.json` imported as implicit `default` profile (read-only; first run
   offers `/jev profile save default-import`).
3. Pro overrides file `pi-jev-router-pro.json` (optional): `virtual.{provider,id}`, `dormancy`,
   `faultInjection` (dev-only: `{"firstTransient": "429", "onRequest": 1}` to force a synthetic
   transient error for offline fallback verification).
4. Env: `JEV_ROUTER_MODE`, `JEV_ROUTER_OFF`, `TYPESAFE_API_KEY`, `TYPESAFE_API_URL` (same
   defaults as legacy config.ts:196-199).

## 7. Verification strategy

- **Offline unit tests** (vitest, no network): chain ordering (incl. `xpremium`, priority,
  minTier), transient/permanent/overflow classification, parking TTL, retry-advance over
  `state.attempted`, budget/quota eligibility, profile store round-trip, decision table for all
  four `reason`s (mock `ModelRouteRequest`).
- **Fault injection:** `faultInjection` forces the first N routed requests to fail with a
  synthetic 429 so the retry-fallback path is exercised deterministically in a live local pi
  session against the operator's real second candidate.
- **Live smoke** (explicitly instructed by operator; minimal prompts, operator's own profiles):
  select `jev/auto` → one prompt per tier band → `/jev-router` shows correct dispatch →
  fault-injected fallback switches chain visibly → profile switch mid-session changes next
  dispatch → cost/session entries sane. Full checklist in `tasks.md` §9.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Fallback switches lose prompt cache + thinking signatures | Sticky `continuation`; switches only on failure/judgment change (constitution §6). |
| Retry budget (3) < chain length | Parking + pre-flight skip converge across turns; documented. |
| Legacy file watchers conflict while both routers installed | README migration note; pro ignores legacy config except the one-time import; tasks gate removal on operator confirmation. |
| `route()` throw loops | Throw only once per chain exhaustion; pi surfaces error and settles (guard: `state.attempted` non-empty check). |
| Secret leakage in logs | Env names only; publish command sources token without echo (constitution §10). |

## 9. Packaging & distribution

- `package.json`: name `pi-jev-router-pro`, `version 0.1.0`, `type: module`, `pi.extensions:
  ["./src/index.ts"]`, `peerDependencies: {"@earendil-works/pi-coding-agent": ">=1.4.0"}`,
  devDeps pinned to `^1.4.0`, keywords incl. `pi-package`. `files`: `src`, `README.md`,
  `USAGE.md`, `LICENSE`.
- GitHub: `gh repo create 01Joseph-Hwang10/pi-jev-router-pro --public --source . --push`.
- Publish: `.npmrc` with `${NPM_TOKEN}` + token loaded from the reference repo's `.env` in the
  same shell invocation (constitution §10). Install: `pi install npm:pi-jev-router-pro`;
  dev loop: `pi --extension ./src/index.ts`.
