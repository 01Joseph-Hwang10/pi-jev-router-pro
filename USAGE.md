# Usage — pi-jev-router-pro

Operational reference: setup, per-command behavior, config knobs, troubleshooting, and the
live smoke checklist. Conceptual overview lives in [README.md](README.md).

## Setup

1. **pi ≥ 1.4** (virtual models). Check with `pi --version`.
2. **TypeSafe credentials**: `TYPESAFE_API_KEY` in your environment or `~/.pi/.env`. Optional
   endpoint override via `TYPESAFE_API_URL` (default `https://api.typesafe.ai/v1/systemone`).
3. **Install**: `pi install npm:pi-jev-router-pro`.
4. **Select the router**: `/model` → `jev/auto` (levels: low, medium, high, xhigh). It is also
   auto-selected at session start when enabled.

Nothing else is required: with no profiles file and no legacy config, the built-in
provider chains route the session.

## Profiles

A profile is a routing configuration unit, shape-compatible with the legacy router config:

```jsonc
// ~/.pi/agent/pi-jev-model-router-profiles.json
{
  "zai": {
    "description": "Z.ai GLM models",
    "useDefaultModels": false,
    "routes": {
      "quick":    [{ "provider": "zai", "model": "glm-5.3-flash" }],
      "standard": [{ "provider": "zai", "model": "glm-5.3" }],
      "high":     [{ "provider": "zai", "model": "glm-5.3" }],
      "premium":  [{ "provider": "zai", "model": "glm-5.3" }],
      "xpremium": []
    },
    "kindModels": {
      "plan": [{ "provider": "zai", "model": "glm-5.3", "minTier": "premium" }],
      "implement": [{ "provider": "zai", "model": "glm-5.3-flash", "minTier": "standard" }]
    }
  }
}
```

Every chain is an **ordered candidate list**; the first available + eligible model wins.
Resolution order per request: free pool (per `free.policy`) → kind specialists eligible at the
judged tier (`priority` desc) → the tier's chain → adjacent tiers nearest-first (−1, +1, −2, +2…).

### Switching

`/jev profile switch zai` (or `/jev zai`) swaps the chains **in memory** and writes only the
active profile name to `pi-jev-router-pro-state.json`. The next request dispatches from the new
profile. No legacy config rewrite, no reload.

If the state file syncs across machines (e.g. Syncthing), concurrent writes leave
`*.sync-conflict-*` copies behind. On startup the extension merges every conflict copy into the
state file — spend ledgers by max per model (never over-reports spend), parks unioned, newest
profile switch wins — then deletes the copies, so no spend data is lost to a sync race.

### CRUD

- `/jev profile add [name]` — capture the active profile, copy an existing one, or write JSON
  in the editor.
- `/jev profile save [name]` — persist the active routing config under a new name. The special
  name `default-import` persists the implicit legacy-imported `default` profile.
- `/jev profile edit [name]` — JSON editor, rename, description, `useDefaultModels` toggle,
  overwrite from the active profile.
- `/jev profile clone <src> <target>` / `remove [name]` — destructive ops ask for confirmation.
- `/jev profile init` — starter examples when the file is missing entirely.

### Account awareness

Profile detail views (`current`, `show`) and switches report pi-account-switcher status for the
profile's providers (read-only): which accounts exist and which is active, with an advisory when
a provider has accounts but none selected.

## How requests are routed

| Reason | Behavior |
|---|---|
| `user` | Jev classifies the prompt (cached per prompt text, 60 s) → tier + kind → chain → first eligible target. Jev unavailable → warn + sticky dispatch; the turn is never blocked. |
| `continuation` | Tool follow-ups and extension messages stay on `previous` unless it became ineligible; then re-resolve from the stored judgment without re-classifying. |
| `retry` | Transient error (429/5xx/529/rate-limit/timeout/network) → advance past the failed target. Permanent (401/403, `model_not_found`, retired/withdrawn — with the model named in the error) → park for `recovery.parkMs` + advance. Context overflow → stay sticky; pi's compaction recovery owns it. Unknown → advance without parking. Chain exhausted → `route()` throws; the error stays visible. |
| `direct` | Compaction summaries and `streamSimple()` calls dispatch the cheapest healthy target; no router-state writes. |

pi retries up to its `retry.maxRetries` (default 3), so at most ~4 physical attempts happen per
turn; leftover failures converge on later turns via parking and pre-flight skips.

## Eligibility (pre-flight, fail-open)

1. Model exists in the catalog and the provider has credentials.
2. Not parked — else note `skipped: model temporarily parked`.
3. Quota snapshot allows (Codex; unknown/stale admits with a note, or skips with
   `quota.openai-codex.onUnknown: "skip"`).
4. Budget allows (soft breach → one tier down; hard breach → cap at quick/standard).

All notes surface in the decision entry (`ctrl+o` style expansion in the transcript shows the
raw judgment: kind, complexity, capability, reasoning, budget).

## Budget & quota

```jsonc
{
  "budget": { "dailyUsd": 5, "monthlyUsd": 50, "softRatio": 0.7, "hardRatio": 0.9 },
  "quota": {
    "openai-codex": { "enabled": true, "cacheTtlSec": 120, "onUnknown": "use", "minQuota": { "fiveHour": 0.2 } }
  }
}
```

Set these in the profile (per-profile budgets) — or rely on the defaults (soft 0.7 / hard 0.9,
no caps). Spend is accounted from assistant-message costs into the pro state file.

## Consent modes

- `auto` — switch silently (default).
- `confirm` — prompt before switches per `confirm.tiers` (empty = all switches); timeout policy
  `confirm.onTimeout` (`accept`/`reject`) with `confirm.timeoutMs`.
- `notify` — never switch; dispatch the current model and report.

`/jev-router mode auto|confirm|notify` overrides per session; `JEV_ROUTER_MODE` / `JEV_ROUTER_OFF=1`
from the environment.

## Pro knobs (`~/.pi/agent/pi-jev-router-pro.json`)

```jsonc
{
  "virtual": { "provider": "jev", "id": "auto", "name": "Auto (Jev Pro)" },
  "dormancy": true,
  "detectLegacyProfile": true,
  "profilesPath": "/absolute/path/to/profiles.json",
  "faultInjection": { "firstTransient": "429", "onRequest": 1, "mode": "throw" }
}
```

All optional; defaults give `jev/auto`, auto-select enabled, legacy profile detection on, and no
injection. `dormancy: false` never auto-selects at session start (fully detached until
`/jev auto`); `detectLegacyProfile: false` skips legacy-config profile detection and the
implicit `default` import.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| `jev-pro: <profile> · dormant` in the footer | A physical model is selected. `/jev auto` re-activates. |
| No decision entries | The router is dormant, disabled (`/jev-router on`), or `JEV_ROUTER_OFF` is set. |
| `judgment unavailable (missing API key)` | Set `TYPESAFE_API_KEY`; routing continues sticky. |
| `not in the catalog — staying put` | The chain names a model this build doesn't list; fix the profile or enable the provider. |
| Repeated `parked until …` | Permanent failures parked the model; `/jev-router parking clear` resets. |
| Duplicate routing warnings | The legacy router is still installed; finish verification, then remove it. |
| Quota shows stale | Codex reading expired; eligibility fails open unless `onUnknown: "skip"`. |

## Live smoke checklist

Run after install (and after any meaningful change):

1. `/model` → select `jev/auto`; footer shows the dispatch after the first prompt.
2. Prompt classes: explain (quick), implement (standard/high), plan (premium) — entries match
   the active profile's chains.
3. Fault injection: `firstTransient: "429"` → attempt 1 fails synthetically → attempt 2 on the
   chain's second entry; entry says fallback. Single-entry chain → visible error, no loop.
4. `/jev profile switch <other>` → next prompt dispatches from the other profile (no reload).
5. `/jev-router` → mode, profile, chains, parking, budget/quota all sane.
6. `jev_route` tool call from a subagent prompt works.
