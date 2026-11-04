# Tasks — Change 001

Constitution: v1.0.0. Gates: §12 (typecheck + tests before publish; verification before
retirement of legacy packages). Work top-to-bottom; do not skip gate markers.

## 0. Prerequisites

- [ ] 0.1 Confirm tooling: `gh` authed (`01Joseph-Hwang10` ✅ verified during planning); npm
      publish auth available via `NPM_TOKEN` (reference repo `.env` ✅ verified);
      `pnpm`, `node ≥ 22` present.
- [ ] 0.2 Confirm `TYPESAFE_API_KEY` present in `~/.pi/.env` (✅ verified; name only — never
      print values).
- [ ] 0.3 Skim reference implementation
      `~/Documents/projects/me/pi-jev-model-router-profile-switcher/src/` (commands, storage,
      runtime, shared) and `tests/` — port, don't reinvent.

## 1. Scaffold

- [ ] 1.1 Create `~/Documents/projects/me/pi-jev-router-pro` git repo (`.gitignore` incl.
      `.env`, `node_modules`, `dist`); MIT LICENSE; README stub.
- [ ] 1.2 `package.json` per design §9 (`pi.extensions`, peerDep `>=1.4.0`); `tsconfig.json`
      + `vitest.config.ts` ported from reference; `pnpm install`.
- [ ] 1.3 `gh repo create 01Joseph-Hwang10/pi-jev-router-pro --public --source . --push`;
      initial commit = scaffolding + `specs/`.

**Gate G1:** `pnpm typecheck` clean on scaffold.

## 2. Domain & config

- [ ] 2.1 `domain/types.ts`: port Tier/RouteTarget/JevProfile (+ `xpremium` everywhere), add
      `ProConfig` (virtual, dormancy, faultInjection) — constitution §11 compat.
- [ ] 2.2 `storage/paths.ts`: state/paths incl. legacy reads (profiles file, legacy router
      json, old state files for migration hints).
- [ ] 2.3 `jev/config.ts` + `jev/client.ts`: port defaults (`TYPESAFE_API_KEY`,
      `TYPESAFE_API_URL`, `jev-latest`) and classifier client.
- [ ] 2.4 `domain/errors.ts`: transient/permanent/overflow classification + port
      `isModelUnavailable` identity guard (R4, R5).

## 3. Routing core

- [ ] 3.1 `domain/chain.ts`: chain builder (free pool → kind candidates → tier chain →
      adjacent tiers) + `firstEligible()` (R2.1).
- [ ] 3.2 `routing/parking.ts` (persisted TTL map, port Parking), `quota.ts`, `budget.ts`
      (defaults: soft .7 / hard .9, deadband .25, free `prefer`, recovery parkMs 3 600 000).
- [ ] 3.3 `routing/router.ts`: decision table for `user|continuation|retry|direct` (§3),
      `RouterState` handling, chain-exhausted throw (R2–R7).
- [ ] 3.4 Cache-aware tier-move suppression (R3.2).

## 4. Integration surface

- [ ] 4.1 `index.ts`: register virtual model; `session_start` auto-select; `model_select`
      dormancy; duplicate-legacy warning (R1, R9.3).
- [ ] 4.2 `ui/entries.ts`: decision entries + renderers (R2.2); `ui/status.ts` widget (R8.4).
- [ ] 4.3 Commands: `/jev profile …` CRUD + switch, `/jev auto`, `/jev-router`, `/jev-route`,
      legacy `/jev-profile*` aliases (R8.3); `jev_route` tool (port).
- [ ] 4.4 Account-switcher awareness reporting (R8.5).

## 5. Tests (offline)

- [ ] 5.1 Chain golden tables (tiers incl. `xpremium`, priority, minTier, free policy).
- [ ] 5.2 Error classification + retry-advance table (all four reasons, R4.1–R4.5, R5.1–R5.2).
- [ ] 5.3 Parking TTL persistence; quota/budget eligibility notes (R6).
- [ ] 5.4 Profiles store round-trip against the operator's real profiles-file shape (R8.1,
      R9.1); legacy import.
- [ ] 5.5 Consent-mode matrix (R10.1).

**Gate G2:** `pnpm typecheck && pnpm test` fully green (R11.1).

## 6. Live verification (fault-injected, then real)

- [ ] 6.1 Dev run: `pi --extension ./src/index.ts` in a scratch project; `/model` shows
      `jev/auto`; auto-select works; dormancy + `/jev auto` (R1).
- [ ] 6.2 Enable `faultInjection.firstTransient: "429"` with a two-entry chain (dead/invalid
      first? no — first real, second real): verify visible fallback on first retry, decision
      entries correct (R4.2/R4.3), exhaustion path with single-entry chain (R4.4).
- [ ] 6.3 Profile switch mid-session changes next dispatch without reload (R8.2);
      `/jev-router` status; parking list (R5.1).
- [ ] 6.4 Disable fault injection; one real prompt per tier band on the operator's active
      profile; verify judgment entries + costs (minimal prompts; operator's own providers).

## 7. Publish & install

- [ ] 7.1 Finalize README (install, config, migration from legacy duo), USAGE.md.
- [ ] 7.2 Version `0.1.0`; commit; push.
- [ ] 7.3 Publish: create `.npmrc` with `${NPM_TOKEN}`; run publish in one shell invocation
      loading `NPM_TOKEN` from the reference repo's `.env` (no echo, no tracked secrets).
      **Gate G3:** `npm view pi-jev-router-pro` resolves.
- [ ] 7.4 `pi install npm:pi-jev-router-pro`; restart session; repeat 6.1 sanity (R11.2).

## 8. Retirement (operator-gated)

- [ ] 8.1 Present verification summary to operator; await explicit confirmation.
- [ ] 8.2 On confirmation: `pi uninstall`/remove `pi-jev-model-router` and
      `pi-jev-model-router-profile-switcher`; archive `pi-jev-model-router.json` → import as
      `default` profile; clean stale state files; final `/jev-router` sanity.

## 9. Live smoke checklist (transcribed into PR/release notes)

1. `/model` → select `jev/auto`; footer shows dispatch after first prompt.
2. Prompt classes: explain (quick), implement (standard/high), plan (premium) — entries match
   profile chains.
3. Fault injection: 429 on attempt 1 → attempt 2 on chain entry 2; entry says `fallback`.
4. Single-entry chain + injection → visible error, no loop.
5. `/jev profile switch <other>` → next prompt dispatches from other profile (no reload).
6. `/jev-router` → mode, profile, chains, parking, budget/quota all sane.
7. `jev_route` tool call from a subagent prompt works.
