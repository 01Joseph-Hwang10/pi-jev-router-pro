# pi-jev-auto

Single-surface TypeSafe Jev model router for the [Pi coding agent](https://github.com/earendil-works/pi).

One virtual model — **`jev/auto`** by default — routes every request to a physical
`{model, thinkingLevel}` pair chosen by a Jev typed judgment, an ordered candidate chain, and a
fail-open eligibility filter (parking, quota, budget). It replaces the legacy
`pi-jev-model-router` + `pi-jev-model-router-profile-switcher` duo with one extension.

```
jev/auto:high  →  zai-coding-cn/glm-5.3-flash:medium      (dispatch recorded per assistant message)
```

## Why

- **Judgment routing.** Every user prompt is classified by TypeSafe Jev (task kind, complexity,
  capability deserved, deep-reasoning need) and dispatched to the matching tier:
  `quick | standard | high | premium | xpremium`. Kind specialists (`kindModels`) are tried
  first when the judged tier is at or above their `minTier`.
- **Mid-turn transient fallback.** On a retried request with a transient error
  (429 / 5xx / 529 / rate-limit / timeout / network), the router advances the chain past the
  failed target — mid-turn, mid-chain-of-thought — using pi's virtual-model `retry` hook.
  Chain exhausted → the router throws, and the run ends with the original error visible.
- **Permanent failure parking.** 401/403, `model_not_found`, and decommissioned/retired/
  withdrawn models (identified by name in the error text) are parked for
  `recovery.parkMs` (default 1 h), persisted to disk, and skipped pre-flight on later turns.
- **Profiles are first-class data.** Reads your existing
  `~/.pi/agent/pi-jev-model-router-profiles.json` unchanged; switching is in-memory plus one
  state file — no config rewrites, no reloads.
- **Cache-aware moves.** An avoidable tier switch inside the demand deadband (default 0.25) is
  suppressed so the provider's prompt cache stays warm.

## Install

```bash
pi install npm:pi-jev-auto
```

Requires pi ≥ 1.4 (virtual models) and a TypeSafe API key in `TYPESAFE_API_KEY`
(`~/.pi/.env` works). Development loop: `pi --extension ./src/index.ts`.

## Migration from the legacy duo

1. Install this package. On first run the legacy `pi-jev-model-router.json` is offered as an
   implicit `default` profile (read-only) — run `/jev profile save default-import` to persist it.
2. Your profiles file keeps working untouched. The active profile is stored in
   `~/.pi/agent/pi-jev-auto-state.json`; a legacy config that exactly matches a known
   profile is detected automatically.
3. Keep both installed while verifying. pi warns once per session about duplicate routing
   surfaces. Remove the legacy duo (`pi uninstall`) only after the smoke checklist is green.
4. Legacy commands keep working: `/jev-profile`, `/jev-profiles`, `/jev-profile-add`, … are
   aliases of the `/jev profile …` surface.

## Commands

| Command | Behavior |
|---|---|
| `/jev auto` | Re-activate routing (select the virtual model). |
| `/jev profile [name]` | Switch profile (interactive picker when omitted). Takes effect on the next request. |
| `/jev profile list` | Profiles with active marker, provider badges, and switch picker. |
| `/jev profile current` / `show [name]` | Full detail incl. pi-account-switcher account status. |
| `/jev profile add \| save \| edit \| clone \| remove \| init \| reload` | Full CRUD with editors and confirmation guards. |
| `/jev-router` | Status: mode, active profile, tier chains, parking, budget/quota, built-ins. |
| `/jev-router on\|off\|mode <m>\|parking clear\|quota` | Session overrides and detail views. |
| `/jev-route <text>` | Classify preview — no switching. Also a model-callable tool: `jev_route`. |

## Dormancy

Selecting a physical model manually parks the router (one warning, no routing, no entries);
`/jev auto` or selecting `jev/auto` re-activates it. While dormant the extension is fully inert.

## Consent modes

`mode` is preserved from the legacy router: `auto` switches silently; `confirm` prompts before
switches (tier jumps and fallbacks) per `confirm.tiers`/timeout policy; `notify` never switches —
it dispatches the current model and reports what it would have done. Env knobs
`JEV_ROUTER_MODE` and `JEV_ROUTER_OFF` are honored.

## Files

| File | Purpose |
|---|---|
| `~/.pi/agent/pi-jev-model-router-profiles.json` | Profiles (legacy name kept; `JEV_ROUTER_PROFILES` or `profilesPath` overrides). |
| `~/.pi/agent/pi-jev-auto.json` | Pro knobs: `virtual.{provider,id,name}`, `dormancy`, `profilesPath`, `faultInjection`. |
| `~/.pi/agent/pi-jev-auto-state.json` | Active profile name, persisted parking, spend ledger. |
| `~/.pi/agent/pi-jev-auto-quota.json` | Codex quota reading cache. |

The legacy `pi-jev-model-router.json` is **read-only** to this extension.

## Fault injection (offline fallback verification)

```jsonc
// ~/.pi/agent/pi-jev-auto.json
{
  "faultInjection": { "firstTransient": "429", "onRequest": 1, "mode": "throw" }
}
```

The first `onRequest` routed dispatches fail with the synthetic transient error, so pi's real
retry path runs and the fallback becomes visible against your real second candidate.
`"mode": "advance"` skips the candidate without a real failure (purely cosmetic simulation).
The fallback decision entry is labeled `fault injection`. Remove the block when done.

## Config compatibility

Config shapes (`routes`, `kindModels`, tiers `quick|standard|high|premium|xpremium`,
`RouteTarget {provider, model, thinkingLevel?, minTier?, priority?, minQuota?}`, `free`,
`budget`, `cache`, `confirm`, `recovery`) are compatible with the legacy router's schema.
With `useDefaultModels: false`, built-ins are gone entirely. New knobs are optional and default
to legacy-equivalent behavior: budget soft/hard 0.7/0.9, cache deadband 0.25, free policy
`prefer`, recovery parkMs 3 600 000.

## Development

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest — offline decision-table tests, no network
```

## License

MIT — see [LICENSE](LICENSE).
