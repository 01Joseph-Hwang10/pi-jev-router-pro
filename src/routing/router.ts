import type { JevRouterConfig, RouteTarget, RouterState, StoredJudgment, Tier } from "../domain/types.js";
import { TIERS } from "../domain/types.js";
import {
  buildOrderedChain,
  cacheHold,
  decisionReason,
  eligibleTarget,
  firstAvailable,
  kindCandidates,
  targetForModel,
  tierForModel,
  type AvailableModel,
  type TargetEligibility,
} from "../domain/chain.js";
import { classifyFailure, JevChainExhausted, toStoredJudgment, type FailureKind } from "../domain/errors.js";
import type { RouteAnalysis } from "../jev/client.js";
import type { SpendSnapshot } from "./budget.js";

/**
 * The `route()` decision table (design §3, spec R2–R7). Pure over injected
 * inputs so the whole table is unit-testable offline with mock
 * `ModelRouteRequest`-shaped data (design §7).
 */

export type RouteReason = "user" | "continuation" | "retry" | "direct";
export interface PhysicalRef {
  provider: string;
  id: string;
  thinkingLevel?: string;
}

export interface RouteInput {
  reason: RouteReason;
  /** Selected virtual thinking level (router input). */
  thinkingLevel: string;
  /** Physical model + level of the latest successful response, when present. */
  previous?: PhysicalRef;
  /** For `retry`: the failed request. */
  failed?: { model: PhysicalRef; message: { stopReason?: string; errorMessage?: string } };
  /** Router state last returned on this session branch. */
  state?: RouterState;
  /** The prompt text to judge (`user` only). */
  prompt?: string;
  /** Recent conversation excerpt for the classifier. */
  history?: string;
  /** Tokens currently in context, used to price a cache miss. */
  contextTokens?: number;
  /** Signals that no classification may run (continuations reuse state). */
  signal?: AbortSignal;
}

export interface RouteDecision {
  action: "switched" | "kept" | "notified" | "skipped" | "fallback";
  /** Physical dispatch target. */
  target: RouteTarget;
  model: AvailableModel;
  /** Thinking level to dispatch (target pin or virtual passthrough). */
  thinkingLevel: string;
  tier: Tier;
  tierIndex: number;
  desiredTier?: Tier;
  reason: string;
  notes: string[];
  analysis?: StoredJudgment;
  held?: boolean;
  downgraded?: boolean;
  lowConfidenceFallback?: boolean;
  kindSpecialised?: boolean;
  /** Set for `retry` outcomes. */
  failure?: { kind: FailureKind; modelKey: string; errorMessage: string };
  /** True when the router would not or could not change anything. */
  warnOnly?: boolean;
}

export interface ResolvedRoute {
  route: { provider: string; id: string; thinkingLevel: string };
  decision: RouteDecision;
  /** New router state, or `request.state` itself to keep the current one. */
  state: RouterState;
}

export interface RouteEnvironment {
  config: JevRouterConfig;
  models: readonly AvailableModel[];
  spend: SpendSnapshot;
  /** Pre-flight eligibility (parking + quota); fail-open (constitution §4). */
  eligibility: TargetEligibility;
  /** Jev classifier; may reject (R2.3 fail-open). */
  classify: (input: { prompt: string; history?: string; contextTokens?: number; signal?: AbortSignal }) => Promise<RouteAnalysis>;
  /** Confirmation dialog for consent-gated switches (R10.1); optional. */
  confirmSwitch?: (decision: RouteDecision) => Promise<boolean>;
  /** Notifications (warn on Jev unavailability, notes, notify-mode). */
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  /** Persist a parked target (R5); injected so tests stay in-memory. */
  park?: (key: string) => void;
  /** Configured direct target override (R7.1). */
  directTarget?: RouteTarget;
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const PREMIUM = TIERS.indexOf("premium");

/**
 * Judgment → tier (port of the legacy `decide()` tier math):
 *   demand = 0.55 * complexity + 0.45 * capability_deserved, nudged by deep reasoning
 *   demand = max(demand, kind floor)
 *   then: confidence guard → xpremium eligibility → budget guard
 */
export function computeTier(
  analysis: { kind: string; kindConfidence: number; complexity: number; budgetIntensity: number; deepReasoning: number },
  config: JevRouterConfig,
  spend: SpendSnapshot,
  notes: string[],
): { demand: number; desiredIndex: number; index: number; lowConfidenceFallback: boolean; xpremiumEligible: boolean; downgraded: boolean } {
  let demand = 0.55 * analysis.complexity + 0.45 * analysis.budgetIntensity;
  if (analysis.deepReasoning >= 0.65) demand += 0.75;
  else if (analysis.deepReasoning <= 0.2) demand -= 0.25;
  demand = clamp(demand, 0, 3);
  const demandReachesPremium = Math.round(demand) >= PREMIUM;

  const kindFloor = Math.min(tierIndexOfFloor(config, analysis.kind), PREMIUM);
  if (demand < kindFloor) {
    notes.push(`${analysis.kind} floors at ${TIERS[kindFloor]}`);
    demand = kindFloor;
  }

  let desiredIndex = clamp(Math.round(demand), 0, PREMIUM);
  let index = desiredIndex;
  let lowConfidenceFallback = false;

  // Confidence guard: don't spend premium money on an unsure classification.
  if (config.confidenceThreshold > 0 && analysis.kindConfidence > 0 && analysis.kindConfidence < config.confidenceThreshold && index > 1) {
    notes.push(`low kind confidence ${analysis.kindConfidence.toFixed(2)} → standard`);
    index = 1;
    lowConfidenceFallback = true;
  }

  // Demand tops out at premium; xpremium is reached only through eligibility.
  const xpremiumEligible =
    config.routes.xpremium.length > 0 && demandReachesPremium && analysis.kindConfidence > 0 && analysis.kindConfidence >= config.confidenceThreshold;
  if (xpremiumEligible) {
    desiredIndex = PREMIUM + 1;
    index = desiredIndex;
  }

  // Budget guard: hard pressure forces the cheap tier unless the work is clearly architectural.
  let downgraded = false;
  if (spend.pressure >= config.budget.hardRatio && spend.pressure > 0) {
    const forced = demand >= 2.5 ? 1 : 0;
    if (forced < index) {
      notes.push(`budget ${(spend.pressure * 100).toFixed(0)}% of cap (${formatUsdShort(spend)} today) → capped at ${TIERS[forced]}`);
      index = forced;
      downgraded = true;
    }
  } else if (spend.pressure >= config.budget.softRatio && spend.pressure > 0) {
    if (index > 0) {
      notes.push(`budget ${(spend.pressure * 100).toFixed(0)}% of cap → one tier down`);
      index -= 1;
      downgraded = true;
    }
  }

  return { demand, desiredIndex, index, lowConfidenceFallback, xpremiumEligible, downgraded };
}

function tierIndexOfFloor(config: JevRouterConfig, kind: string): number {
  const floor = config.kindMinimumTier[kind] ?? "quick";
  const index = TIERS.indexOf(floor);
  return index < 0 ? 0 : index;
}

function formatUsdShort(spend: SpendSnapshot): string {
  if (spend.today >= 1) return `$${spend.today.toFixed(2)}`;
  return `$${spend.today.toFixed(4)}`;
}

/** R6.2/R6.3 pre-flight note surfacing is handled by `eligibility`; this is the shared pick. */
function pickFirst(env: RouteEnvironment, chain: readonly RouteTarget[], notes: string[]): { target: RouteTarget; model: AvailableModel } | undefined {
  return firstAvailable(env.models, chain, env.eligibility, notes);
}

/** The chain a retry advances along: rebuilt from the stored judgment. */
function retryChain(env: RouteEnvironment, state: RouterState | undefined): RouteTarget[] {
  const judgment = state?.lastJudgment;
  const tierIndex = tierIndexFromStored(env.config, state, judgment);
  const kind = judgment?.kind ?? "chat";
  return buildOrderedChain(env.config, kind, tierIndex);
}

function tierIndexFromStored(config: JevRouterConfig, state: RouterState | undefined, judgment: StoredJudgment | undefined): number {
  if (state?.lastTier) {
    const index = TIERS.indexOf(state.lastTier);
    if (index >= 0) return index;
  }
  if (judgment) {
    return Math.min(computeTier(judgment, config, { today: 0, month: 0, pressure: 0 }, []).index, PREMIUM + (config.routes.xpremium.length > 0 ? 1 : 0));
  }
  return TIERS.indexOf("standard");
}

/**
 * Resolve one route() invocation. Throws `JevChainExhausted` only from the
 * chain-exhaustion path (R4.4). Never blocks a turn on Jev errors (R2.3).
 */
export async function resolveRoute(input: RouteInput, env: RouteEnvironment): Promise<ResolvedRoute> {
  const { config } = env;
  const notes: string[] = [];

  // `direct` (R7.1): cheapest healthy target, no state writes.
  if (input.reason === "direct") {
    const chain = env.directTarget ? [env.directTarget, ...config.routes.quick] : config.routes.quick;
    const pick = pickFirst(env, chain, notes);
    if (!pick) throw new JevChainExhausted([], "no eligible model for a direct request");
    return {
      route: { provider: pick.target.provider, id: pick.target.model, thinkingLevel: input.thinkingLevel },
      decision: {
        action: "kept",
        target: pick.target,
        model: pick.model,
        thinkingLevel: input.thinkingLevel,
        tier: "quick",
        tierIndex: 0,
        reason: "direct request (compaction/summary) → cheapest healthy target",
        notes,
      },
      state: input.state ?? {},
    };
  }

  const previous = input.previous;
  const previousKey = previous ? modelKey(previous) : undefined;
  const previousModel = previousKey ? env.models.find((m) => modelKey(m) === previousKey) : undefined;

  // ------------------------------------------------------------------ user
  if (input.reason === "user") {
    let analysis;
    try {
      analysis = await env.classify({
        prompt: input.prompt ?? "",
        history: input.history,
        contextTokens: input.contextTokens,
        signal: input.signal,
      });
    } catch (error) {
      // R2.3: Jev unavailable → warn + sticky dispatch; the turn is never blocked.
      const message = error instanceof Error ? error.message : String(error);
      env.notify?.(`jev-router-pro: judgment unavailable (${message}) — staying on ${previousKey ?? "the first configured candidate"}`, "warning");
      const fallback = stickyOrFirst(env, previous, notes);
      if (!fallback) throw new JevChainExhausted([], message);
      return {
        route: { provider: fallback.target.provider, id: fallback.target.model, thinkingLevel: fallback.target.thinkingLevel ?? input.thinkingLevel },
        decision: {
          action: "kept",
          target: fallback.target,
          model: fallback.model,
          thinkingLevel: fallback.target.thinkingLevel ?? input.thinkingLevel,
          tier: (TIERS[tierForModel(modelKey(fallback.model), config) ?? 1] as Tier) ?? "standard",
          tierIndex: tierForModel(modelKey(fallback.model), config) ?? 1,
          reason: `Jev unavailable — sticky dispatch (${message})`,
          notes,
          warnOnly: true,
        },
        state: { attempted: [modelKey(fallback.model)] },
      };
    }

    const stored = toStoredJudgment(analysis);
    const tierMath = computeTier(analysis, config, env.spend, notes);

    // The ordered candidate chain: free pool → kind specialists → tier chain → adjacent tiers.
    const chain = buildOrderedChain(config, analysis.kind, tierMath.index);
    const pick = pickFirst(env, chain, notes);
    if (!pick) {
      // R2.4: nothing configured/eligible — never invent a model.
      if (previousModel) {
        notes.push("no eligible configured route — staying on the current model");
        return {
          route: { provider: previous!.provider, id: previous!.id, thinkingLevel: previous!.thinkingLevel ?? input.thinkingLevel },
          decision: {
            action: "skipped",
            target: targetForModel(config, previousModel),
            model: previousModel,
            thinkingLevel: previous!.thinkingLevel ?? input.thinkingLevel,
            tier: TIERS[Math.min(tierForModel(previousKey, config) ?? 1, PREMIUM)],
            tierIndex: tierForModel(previousKey, config) ?? 1,
            reason: `no eligible route for ${analysis.kind} → ${TIERS[tierMath.index]}`,
            notes,
            analysis: stored,
          },
          state: { attempted: previousKey ? [previousKey] : [], lastJudgment: stored, lastTier: TIERS[tierMath.index], lastKind: analysis.kind },
        };
      }
      throw new JevChainExhausted([], "no eligible configured route (check routes/kindModels for the judged tier)");
    }

    const usedKindChain = kindCandidates(config, analysis.kind, tierMath.index).some(
      (t) => t.provider === pick.target.provider && t.model === pick.target.model,
    );

    // Cache guard (R3.2): a switch discards the provider's prompt cache; only
    // pay that when the move clears the current band or is worth its penalty.
    const currentIndex = previous ? tierForModel(previousKey, config) : undefined;
    if (previousModel && currentIndex !== undefined) {
      const hold = cacheHold({
        config,
        demand: tierMath.demand,
        desiredIndex: tierMath.desiredIndex,
        index: tierMath.index,
        available: pick,
        current: { index: currentIndex, model: previousModel, target: targetForModel(config, previousModel) },
        contextTokens: input.contextTokens,
        eligibility: env.eligibility,
        notes,
        spend: env.spend,
      });
      if (hold) {
        return {
          route: { provider: previous!.provider, id: previous!.id, thinkingLevel: previous!.thinkingLevel ?? input.thinkingLevel },
          decision: {
            action: "kept",
            target: targetForModel(config, previousModel),
            model: previousModel,
            thinkingLevel: previous!.thinkingLevel ?? input.thinkingLevel,
            tier: TIERS[currentIndex] ?? "standard",
            tierIndex: currentIndex,
            desiredTier: TIERS[tierMath.desiredIndex],
            reason: `${decisionReason(analysis, tierMath.desiredIndex, tierMath.index)}, held on ${TIERS[currentIndex]} to keep the cache`,
            notes,
            analysis: stored,
            held: true,
            lowConfidenceFallback: tierMath.lowConfidenceFallback,
          },
          state: { attempted: previousKey ? [previousKey] : [], lastJudgment: stored, lastTier: TIERS[tierMath.desiredIndex], lastKind: analysis.kind },
        };
      }
    }

    const desiredDecision: RouteDecision = {
      action: previousKey && modelKey(pick.model) === previousKey ? "kept" : "switched",
      target: pick.target,
      model: pick.model,
      thinkingLevel: pick.target.thinkingLevel ?? input.thinkingLevel,
      tier: TIERS[tierMath.index],
      tierIndex: tierMath.index,
      desiredTier: TIERS[tierMath.desiredIndex],
      reason: decisionReason(analysis, tierMath.desiredIndex, tierMath.index),
      notes,
      analysis: stored,
      downgraded: tierMath.downgraded,
      lowConfidenceFallback: tierMath.lowConfidenceFallback,
      kindSpecialised: usedKindChain,
    };

    // Consent modes (R10.1, constitution §9).
    const consent = await applyConsent(desiredDecision, env, previous, input);
    return consent;
  }

  // ---------------------------------------------------------- continuation
  if (input.reason === "continuation") {
    // R3.1: sticky on `previous` when it is still eligible (cache/thinking warmth).
    if (previous && previousModel) {
      const target = targetForModel(config, previousModel);
      const eligibility = env.eligibility(target, previousModel);
      if (eligibility.allowed) {
        return {
          route: { provider: previous.provider, id: previous.id, thinkingLevel: previous.thinkingLevel ?? input.thinkingLevel },
          decision: {
            action: "kept",
            target,
            model: previousModel,
            thinkingLevel: previous.thinkingLevel ?? input.thinkingLevel,
            tier: TIERS[Math.min(tierForModel(previousKey, config) ?? 1, PREMIUM)],
            tierIndex: tierForModel(previousKey, config) ?? 1,
            reason: "continuation — staying on the model handling this turn",
            notes: [...eligibility.notes],
            analysis: input.state?.lastJudgment,
          },
          state: input.state ?? {},
        };
      }
      notes.push(...eligibility.notes, "continuation model no longer eligible — re-resolving");
    }

    // Re-resolve like `user` without re-classifying (reuse state.lastJudgment).
    const judgment = input.state?.lastJudgment;
    let judgmentForState: StoredJudgment | undefined = judgment;
    let tierIndex: number;
    let kind: string;
    if (judgment) {
      tierIndex = tierIndexFromStored(config, input.state, judgment);
      kind = judgment.kind;
    } else {
      // No stored judgment (fresh branch): classify once, fail-open.
      try {
        const analysis = await env.classify({ prompt: input.prompt ?? "", history: input.history, contextTokens: input.contextTokens, signal: input.signal });
        const stored = toStoredJudgment(analysis);
        const tierMath = computeTier(analysis, config, env.spend, notes);
        tierIndex = tierMath.index;
        kind = analysis.kind;
        judgmentForState = stored;
      } catch {
        tierIndex = TIERS.indexOf("standard");
        kind = "chat";
      }
    }
    const chain = buildOrderedChain(config, kind, tierIndex);
    const pick = pickFirst(env, chain, notes);
    if (!pick) {
      if (previous) return sticky(env, input, previous, notes, "no eligible route — staying");
      throw new JevChainExhausted([], "no eligible route for the continuation");
    }
    return {
      route: { provider: pick.target.provider, id: pick.target.model, thinkingLevel: pick.target.thinkingLevel ?? input.thinkingLevel },
      decision: {
        action: "switched",
        target: pick.target,
        model: pick.model,
        thinkingLevel: pick.target.thinkingLevel ?? input.thinkingLevel,
        tier: TIERS[tierIndex],
        tierIndex,
        reason: `continuation re-resolve (${kind} → ${TIERS[tierIndex]})`,
        notes,
        analysis: judgmentForState,
      },
      state: { ...(input.state ?? {}), attempted: [modelKey(pick.model)], lastJudgment: judgmentForState, lastKind: judgmentForState?.kind },
    };
  }

  // ----------------------------------------------------------------- retry
  // R4: transient → advance; permanent → park + advance; overflow → sticky.
  const failed = input.failed;
  const failedKey = failed ? modelKey(failed.model) : undefined;
  const attempted = [...(input.state?.attempted ?? [])];
  const errorMessage = failed?.message?.errorMessage ?? "";

  if (!failed || !failedKey) {
    // Retry after a routing failure (or unknown origin): fail-open sticky.
    const fallback = stickyOrFirst(env, previous, notes);
    if (!fallback) throw new JevChainExhausted(attempted, "retry failed without failure details");
    return {
      route: { provider: fallback.target.provider, id: fallback.target.model, thinkingLevel: fallback.target.thinkingLevel ?? input.thinkingLevel },
      decision: {
        action: "kept",
        target: fallback.target,
        model: fallback.model,
        thinkingLevel: fallback.target.thinkingLevel ?? input.thinkingLevel,
        tier: TIERS[Math.min(tierForModel(modelKey(fallback.model), config) ?? 1, PREMIUM)],
        tierIndex: tierForModel(modelKey(fallback.model), config) ?? 1,
        reason: "retry — no failure details; sticky dispatch",
        notes,
      },
      state: input.state ?? { attempted },
    };
  }

  const kind: FailureKind = classifyFailure(errorMessage, failedKey);
  if (kind === "overflow") {
    // R4.5: not a fallback trigger — sticky `previous`; pi compaction recovery owns it.
    if (previous && previousModel) {
      return {
        route: { provider: previous.provider, id: previous.id, thinkingLevel: previous.thinkingLevel ?? input.thinkingLevel },
        decision: {
          action: "kept",
          target: targetForModel(config, previousModel),
          model: previousModel,
          thinkingLevel: previous.thinkingLevel ?? input.thinkingLevel,
          tier: TIERS[Math.min(tierForModel(previousKey, config) ?? 1, PREMIUM)],
          tierIndex: tierForModel(previousKey, config) ?? 1,
          reason: "context overflow — staying sticky for compaction recovery",
          notes: [errorMessage.slice(0, 200)],
          failure: { kind, modelKey: failedKey, errorMessage },
        },
        state: input.state ?? { attempted },
      };
    }
  }

  let parked = false;
  if (kind === "permanent") {
    // R5: park the target (persisted, TTL recovery.parkMs), then advance.
    env.park?.(failedKey);
    parked = true;
    notes.push(`${failedKey} parked (permanent failure) until TTL expires`);
  } else if (kind === "transient") {
    notes.push(`${failedKey} transient failure — advancing the chain`);
  } else {
    notes.push(`${failedKey} unclassified failure — advancing without parking`);
  }

  // Advance: next untried eligible entry of the built chain (R4.1, R4.2).
  const chain = retryChain(env, input.state);
  const skip = new Set([...attempted, failedKey]);
  const candidates = chain.filter((t) => !skip.has(`${t.provider}/${t.model}`));
  const pick = pickFirst(env, candidates, notes);
  if (!pick) {
    // R4.4: chain exhausted → throw; the run ends with the original error visible.
    env.notify?.(`jev-router-pro: chain exhausted after ${failedKey}${parked ? " (parked)" : ""}; error stays visible`, "warning");
    throw new JevChainExhausted([...new Set([...attempted, failedKey])], errorMessage);
  }

  const pickKey = modelKey(pick.model);
  const judgment = input.state?.lastJudgment;
  const tierIdx = Math.min(tierForModel(pickKey, config) ?? tierIndexFromStored(config, input.state, judgment), PREMIUM + (config.routes.xpremium.length > 0 ? 1 : 0));

  const decision: RouteDecision = {
    action: "fallback",
    target: pick.target,
    model: pick.model,
    thinkingLevel: pick.target.thinkingLevel ?? input.thinkingLevel,
    tier: TIERS[tierIdx] ?? "standard",
    tierIndex: tierIdx,
    reason: `${kind === "permanent" ? "permanent failure" : kind === "transient" ? "transient failure" : "failure"} on ${failedKey} → fallback`,
    notes,
    analysis: judgment,
    failure: { kind, modelKey: failedKey, errorMessage },
  };

  // R10.1: consent-gated fallback when confirm mode guards the candidate tier.
  if (config.mode === "confirm" && (config.confirm.tiers.length === 0 || config.confirm.tiers.includes(decision.tier)) && env.confirmSwitch) {
    const accepted = await env.confirmSwitch(decision);
    if (!accepted) {
      return {
        route: { provider: failed.model.provider, id: failed.model.id, thinkingLevel: input.thinkingLevel },
        decision: {
          ...decision,
          action: "skipped",
          reason: `${decision.reason} — switch declined; retrying the failed model`,
          notes: [...notes, "fallback declined by operator"],
        },
        state: { ...(input.state ?? {}), attempted: [...new Set([...attempted, failedKey])] },
      };
    }
  }

  return {
    route: { provider: pick.target.provider, id: pick.target.model, thinkingLevel: decision.thinkingLevel },
    decision,
    state: { ...(input.state ?? {}), attempted: [...new Set([...attempted, failedKey, pickKey])], lastJudgment: judgment, lastTier: decision.tier, lastKind: input.state?.lastKind },
  };
}

function sticky(env: RouteEnvironment, input: RouteInput, previous: PhysicalRef, notes: string[], why: string): ResolvedRoute {
  const previousModel = env.models.find((m) => modelKey(m) === modelKey(previous));
  const config = env.config;
  return {
    route: { provider: previous.provider, id: previous.id, thinkingLevel: previous.thinkingLevel ?? input.thinkingLevel },
    decision: {
      action: "kept",
      target: previousModel ? targetForModel(config, previousModel) : { provider: previous.provider, model: previous.id },
      model: previousModel ?? { provider: previous.provider, id: previous.id },
      thinkingLevel: previous.thinkingLevel ?? input.thinkingLevel,
      tier: TIERS[Math.min(tierForModel(modelKey(previous), config) ?? 1, PREMIUM)],
      tierIndex: tierForModel(modelKey(previous), config) ?? 1,
      reason: why,
      notes,
      analysis: input.state?.lastJudgment,
    },
    state: input.state ?? {},
  };
}

function stickyOrFirst(env: RouteEnvironment, previous: PhysicalRef | undefined, notes: string[]): { target: RouteTarget; model: AvailableModel } | undefined {
  if (previous) {
    const previousModel = env.models.find((m) => modelKey(m) === modelKey(previous));
    if (previousModel) {
      const target = targetForModel(env.config, previousModel);
      if (eligibleTarget(target, previousModel, env.eligibility, notes)) return { target, model: previousModel };
    }
  }
  return pickFirst(env, buildOrderedChain(env.config, "chat", TIERS.indexOf("standard")), notes);
}

/** Consent modes (R10.1): auto switches silently; confirm prompts; notify never switches. */
async function applyConsent(
  decision: RouteDecision,
  env: RouteEnvironment,
  previous: PhysicalRef | undefined,
  input: RouteInput,
): Promise<ResolvedRoute> {
  const { config } = env;
  const effectiveMode = config.mode;
  const baseState: RouterState = {
    attempted: decision.model ? [modelKey(decision.model)] : [],
    lastJudgment: decision.analysis,
    lastTier: decision.desiredTier ?? decision.tier,
    lastKind: decision.analysis?.kind,
  };

  if (config.mode === "notify") {
    // `notify` never switches: dispatch the current model, notify only.
    env.notify?.(`jev-router-pro: suggests ${decision.tier} (${modelKey(decision.model)}) — notify mode kept the current model\n${decision.reason}`, "info");
    const fallback = stickyOrFirst(env, previous, decision.notes);
    const target = fallback ?? { target: decision.target, model: decision.model };
    return {
      route: { provider: target.target.provider, id: target.target.model, thinkingLevel: target.target.thinkingLevel ?? input.thinkingLevel },
      decision: {
        ...decision,
        action: "notified",
        target: target.target,
        model: target.model,
        thinkingLevel: target.target.thinkingLevel ?? input.thinkingLevel,
        reason: `${decision.reason} — notify mode (no switch)`,
      },
      state: { ...baseState, attempted: [modelKey(target.model)] },
    };
  }

  // Consent modes (R10.1, constitution §9): `confirm` prompts for switches
  // per `confirm.tiers` (empty list → all switches); `auto` is silent;
  // `notify` was handled above.
  const guarded = effectiveMode === "confirm" && (config.confirm.tiers.length === 0 || config.confirm.tiers.includes(decision.tier));
  if (guarded && env.confirmSwitch) {
    const accepted = await env.confirmSwitch(decision);
    if (!accepted) {
      const fallback = stickyOrFirst(env, previous, decision.notes);
      if (!fallback) throw new JevChainExhausted([], "switch declined and no current model available");
      env.notify?.(`jev-router-pro: kept the current model (${modelKey(fallback.model)})`, "info");
      return {
        route: { provider: fallback.target.provider, id: fallback.target.model, thinkingLevel: fallback.target.thinkingLevel ?? input.thinkingLevel },
        decision: {
          ...decision,
          action: "skipped",
          target: fallback.target,
          model: fallback.model,
          thinkingLevel: fallback.target.thinkingLevel ?? input.thinkingLevel,
          reason: `${decision.reason} — switch declined`,
        },
        state: { ...baseState, attempted: [modelKey(fallback.model)] },
      };
    }
  }

  return { route: { provider: decision.target.provider, id: decision.target.model, thinkingLevel: decision.thinkingLevel }, decision, state: baseState };
}
