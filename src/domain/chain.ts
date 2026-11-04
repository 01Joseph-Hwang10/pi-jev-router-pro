import type { JevRouterConfig, RouteChain, RouteTarget, Tier } from "./types.js";
import { TIERS } from "./types.js";
import type { QuotaEligibility } from "../routing/quota.js";
import type { SpendSnapshot } from "../routing/budget.js";
import { formatUsd } from "../routing/budget.js";

/**
 * Ordered chain building and eligibility resolution (constitution §4, R2.1).
 * Ported from the legacy router's `router.ts` helpers.
 */

export type TargetEligibility = (target: RouteTarget, model: AvailableModel) => QuotaEligibility;

export interface AvailableModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  /** Per-million-token rates, straight from the pi model catalogue. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export function eligibleTarget(target: RouteTarget, model: AvailableModel, eligibility?: TargetEligibility, notes?: string[]): boolean {
  const result = eligibility?.(target, model);
  for (const note of result?.notes ?? []) if (notes && !notes.includes(note)) notes.push(note);
  return result?.allowed ?? true;
}

export function tierIndex(tier: Tier | undefined): number {
  const index = TIERS.indexOf(tier ?? "standard");
  return index < 0 ? 1 : index;
}

const PREMIUM = TIERS.indexOf("premium");

export function findModel(models: readonly AvailableModel[], target: RouteTarget): AvailableModel | undefined {
  return models.find((m) => m.provider === target.provider && m.id === target.model) ?? models.find((m) => m.id === target.model) ?? undefined;
}

export function firstAvailable(
  models: readonly AvailableModel[],
  chain: readonly RouteTarget[],
  eligibility?: TargetEligibility,
  notes?: string[],
): { target: RouteTarget; model: AvailableModel } | undefined {
  for (const target of chain) {
    const model = findModel(models, target);
    if (model && eligibleTarget(target, model, eligibility, notes)) return { target, model };
  }
  return undefined;
}

/** Kind specialists eligible at a tier, in the order the chain tries them (R2.1). */
export function kindCandidates(config: JevRouterConfig, kind: string, index: number): RouteTarget[] {
  return (config.kindModels[kind] ?? [])
    .filter((target) => tierIndex(target.minTier) <= index)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || tierIndex(b.minTier) - tierIndex(a.minTier));
}

/** The specialist that wins at each tier from the kind's floor up, merging runs, e.g. `high: a · premium: b`. */
export function describeKindRoutes(
  config: JevRouterConfig,
  models: readonly AvailableModel[],
  kind: string,
  eligibility?: TargetEligibility,
): string {
  const spans: { from: Tier; to: Tier; model: string }[] = [];
  const top = config.routes.xpremium.length > 0 ? PREMIUM + 1 : PREMIUM;
  for (let i = Math.min(tierIndex(config.kindMinimumTier[kind] ?? "quick"), PREMIUM); i <= top; i += 1) {
    const model = firstAvailable(models, kindCandidates(config, kind, i), eligibility)?.model.id ?? "tier chain";
    const last = spans[spans.length - 1];
    if (last?.model === model) last.to = TIERS[i];
    else spans.push({ from: TIERS[i], to: TIERS[i], model });
  }
  return spans.map((s) => `${s.from === s.to ? s.from : `${s.from}–${s.to}`}: ${s.model}`).join(" · ");
}

/** Best-effort reverse lookup: which tier does this model key sit on? */
export function tierForModel(modelKey: string | undefined, config: JevRouterConfig): number | undefined {
  if (!modelKey) return undefined;
  for (const tier of TIERS) {
    if (config.routes[tier].some((t) => `${t.provider}/${t.model}` === modelKey)) return tierIndex(tier);
  }
  for (const chain of Object.values(config.kindModels)) {
    const hit = chain.find((t) => `${t.provider}/${t.model}` === modelKey);
    if (hit) return tierIndex(hit.minTier);
  }
  return undefined;
}

/** The configured route entry for a model, so a held decision can carry its thinking level. */
export function targetForModel(config: JevRouterConfig, model: AvailableModel): RouteTarget {
  const match = (chain: readonly RouteTarget[]) => chain.find((t) => t.provider === model.provider && t.model === model.id);
  if (config.free.enabled) {
    const target = match(config.free.pool);
    if (target) return target;
  }
  for (const tier of TIERS) {
    const target = match(config.routes[tier]);
    if (target) return target;
  }
  for (const chain of Object.values(config.kindModels)) {
    const target = match(chain);
    if (target) return target;
  }
  return { provider: model.provider, model: model.id };
}

/**
 * The full ordered candidate chain for a judged tier and kind (R2.1):
 * free pool (per policy) → kind specialists → `routes[tier]` → adjacent
 * tiers nearest-first (−1, +1, −2, +2 …).
 */
export function buildOrderedChain(config: JevRouterConfig, kind: string, index: number): RouteChain {
  const freePool = config.free.enabled ? config.free.pool : [];
  const kindChain = kindCandidates(config, kind, index);
  const ordered: RouteTarget[] = [];
  if (config.free.policy === "prefer") ordered.push(...freePool);
  ordered.push(...kindChain, ...config.routes[TIERS[index]]);
  const tierCount = config.routes.xpremium.length > 0 ? TIERS.length : PREMIUM + 1;
  for (let offset = 1; offset < tierCount; offset += 1) {
    if (index - offset >= 0) ordered.push(...config.routes[TIERS[index - offset]]);
    if (index + offset < tierCount) ordered.push(...config.routes[TIERS[index + offset]]);
  }
  if (config.free.policy === "fallback-only") ordered.push(...freePool);
  return ordered;
}

/**
 * Estimated extra cost of switching away from a warm prompt cache.
 * Returns 0 when pricing is unknown, so the gate never blocks on guesses.
 */
export function estimateCachePenaltyUsd(contextTokens: number, current: AvailableModel, target: AvailableModel): number {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return 0;
  const targetInput = target.cost?.input;
  if (targetInput === undefined) return 0;
  const coldRatePerToken = (targetInput + (target.cost?.cacheWrite ?? 0)) / 1_000_000;
  const warmRatePerToken = (current.cost?.cacheRead ?? 0) / 1_000_000;
  return Math.max(0, contextTokens * (coldRatePerToken - warmRatePerToken));
}

export function formatTokens(tokens: number | undefined): string {
  if (!tokens || tokens <= 0) return "empty context";
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tokens`;
  return `${tokens} tokens`;
}

export interface CacheHoldContext {
  config: JevRouterConfig;
  demand: number;
  /** Tier the judgment chose, before cache hold. */
  desiredIndex: number;
  /** Tier actually chosen after budget/availability. */
  index: number;
  available: { target: RouteTarget; model: AvailableModel };
  current?: { index: number; model: AvailableModel; target: RouteTarget };
  contextTokens?: number;
  eligibility?: TargetEligibility;
  notes: string[];
  spend: SpendSnapshot;
}

/**
 * Cache-aware tier-move suppression (R3.2, constitution §6). Ported from the
 * tail of the legacy `decide()`: only pay a cache miss when the move clears
 * the current tier's demand band, is a large upgrade, or is cheap enough.
 * Returns the held decision, or undefined when the switch should proceed.
 */
export function cacheHold(input: CacheHoldContext): { hold: true; notes: string[] } | undefined {
  const { config, current } = input;
  if (!config.cache.aware || !current) return undefined;
  const currentIndex = current.index;
  const currentModel = current.model;
  const target = input.available.model;
  if (target.provider === currentModel.provider && target.id === currentModel.id) return undefined;
  if (!(currentIndex <= PREMIUM || input.index > PREMIUM)) return undefined;

  const delta = input.index - currentIndex;
  const penalty = estimateCachePenaltyUsd(input.contextTokens ?? 0, currentModel, target);
  const bandDemand = input.demand;
  const outsideBand =
    bandDemand < currentIndex - 0.5 - config.cache.deadband || bandDemand > currentIndex + 0.5 + config.cache.deadband;
  const bigUpgrade = delta >= config.cache.bypassTierDelta;
  const affordable = penalty <= config.cache.maxPenaltyUsd;

  let holdReason: string | undefined;
  if (delta === 0) {
    // Same tier, different model: a lateral specialist swap.
    if (!affordable) {
      holdReason = `same-tier swap to ${target.id} would cost ~${formatUsd(penalty)} on ${formatTokens(input.contextTokens)} — keeping the warm cache`;
    }
  } else if (!outsideBand) {
    holdReason = `demand ${bandDemand.toFixed(2)} sits inside the ${TIERS[currentIndex]} band (±${config.cache.deadband}) — switch not worth it`;
  } else if (!bigUpgrade && !affordable) {
    holdReason = `cache penalty ~${formatUsd(penalty)} on ${formatTokens(input.contextTokens)} — keeping the warm cache`;
  }

  if (holdReason) {
    input.notes.push(holdReason);
    return { hold: true, notes: input.notes };
  }
  return undefined;
}

export function decisionReason(analysis: { kind: string; complexity: number; budgetIntensity: number; deepReasoning: number }, desiredIndex: number, index: number): string {
  return (
    `${analysis.kind} · complexity ${analysis.complexity.toFixed(2)}/3 · ` +
    `capability ${analysis.budgetIntensity.toFixed(2)}/3 · reasoning ${analysis.deepReasoning.toFixed(2)}` +
    ` → ${TIERS[desiredIndex]}${index === desiredIndex ? "" : ` (used ${TIERS[index]})`}`
  );
}
