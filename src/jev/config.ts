import type {
  BudgetConfig,
  CacheConfig,
  ConfirmConfig,
  FreePoolConfig,
  JevProfile,
  JevRouterConfig,
  QuotaFloors,
  RouteChain,
  RouteTarget,
  Tier,
} from "../domain/types.js";
import { QUOTA_WINDOWS, TASK_KINDS, TIERS } from "../domain/types.js";
import { normalizeQuotaFloors } from "../routing/quota.js";

/** Unused legacy knob, accepted in profiles for shape compatibility. */
export interface RankingUnused {
  scoresFile?: string;
  cutoffs?: { standard: number; high: number; premium: number };
  spreadProviders?: boolean;
}

/**
 * Effective-config assembly. Ported from the legacy router's `config.ts`
 * (defaults, deep merge, env resolution). The profile patch arrives through
 * `profileToRouterConfig` below, keeping profiles shape-compatible with the
 * legacy duo (constitution §11).
 */

export const DEFAULT_CONFIG: JevRouterConfig = {
  enabled: true,
  mode: "auto",
  useDefaultModels: true,
  apiKeyEnv: "TYPESAFE_API_KEY",
  endpointEnv: "TYPESAFE_API_URL",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  jevModel: "jev-latest",
  timeoutMs: 3500,
  minPromptChars: 12,
  historyTurns: 4,
  confidenceThreshold: 0.34,
  stickiness: true,
  routes: {
    quick: [
      { provider: "openrouter", model: "~google/gemini-flash-latest", thinkingLevel: "off" },
      { provider: "openrouter", model: "~openai/gpt-luna-latest", thinkingLevel: "off" },
      { provider: "openrouter", model: "~z-ai/glm-flash-latest", thinkingLevel: "off" },
      { provider: "openrouter", model: "~deepseek/deepseek-v4-flash-latest", thinkingLevel: "off" },
    ],
    standard: [
      { provider: "openrouter", model: "~deepseek/deepseek-pro-latest", thinkingLevel: "low" },
      { provider: "openrouter", model: "openai/gpt-5.4-mini", thinkingLevel: "low" },
      { provider: "openrouter", model: "~z-ai/glm-latest", thinkingLevel: "low" },
    ],
    high: [
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", thinkingLevel: "medium" },
      { provider: "openrouter", model: "~openai/gpt-terra-latest", thinkingLevel: "medium" },
      { provider: "openrouter", model: "~google/gemini-pro-latest", thinkingLevel: "medium" },
      { provider: "openrouter", model: "~x-ai/grok-latest", thinkingLevel: "medium" },
    ],
    premium: [
      { provider: "openrouter", model: "~anthropic/claude-opus-latest", thinkingLevel: "high" },
      { provider: "openrouter", model: "openai/gpt-5.5", thinkingLevel: "high" },
      { provider: "openrouter", model: "~openai/gpt-astra-latest", thinkingLevel: "high" },
    ],
    xpremium: [],
  },
  kindModels: {
    // Planning and design: strong long-horizon reasoners.
    plan: [
      { provider: "openrouter", model: "~anthropic/claude-opus-latest", minTier: "premium" },
      { provider: "openrouter", model: "~openai/gpt-astra-latest", minTier: "premium" },
      { provider: "openrouter", model: "~openai/gpt-terra-latest", minTier: "high" },
      { provider: "openrouter", model: "~google/gemini-pro-latest", minTier: "standard" },
    ],
    // Implementation: coding specialists.
    implement: [
      { provider: "openrouter", model: "openai/gpt-5.3-codex", minTier: "standard" },
      { provider: "openrouter", model: "moonshotai/kimi-k2.7-code", minTier: "standard" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
    debug: [
      { provider: "openrouter", model: "openai/gpt-5.3-codex", minTier: "standard" },
      { provider: "openrouter", model: "~openai/gpt-terra-latest", minTier: "high" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
    refactor: [
      { provider: "openrouter", model: "openai/gpt-5.3-codex", minTier: "standard" },
      { provider: "openrouter", model: "moonshotai/kimi-k2.7-code", minTier: "standard" },
    ],
    // Review and audit: strongest reviewers only.
    review: [
      { provider: "openrouter", model: "~anthropic/claude-opus-latest", minTier: "high" },
      { provider: "openrouter", model: "openai/gpt-5.5", minTier: "high" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
    // Research: long-context readers.
    research: [
      { provider: "openrouter", model: "~google/gemini-pro-latest", minTier: "standard" },
      { provider: "openrouter", model: "moonshotai/kimi-k3", minTier: "standard" },
      { provider: "openrouter", model: "~openai/gpt-terra-latest", minTier: "standard" },
    ],
    explain: [
      { provider: "openrouter", model: "~google/gemini-flash-latest", minTier: "quick" },
      { provider: "openrouter", model: "openai/gpt-5.4-mini", minTier: "quick" },
      { provider: "openrouter", model: "~google/gemini-pro-latest", minTier: "standard" },
    ],
    operate: [
      { provider: "openrouter", model: "openai/gpt-5.4-mini", minTier: "standard" },
      { provider: "openrouter", model: "~deepseek/deepseek-pro-latest", minTier: "standard" },
    ],
    chat: [
      { provider: "openrouter", model: "~google/gemini-flash-latest", minTier: "quick" },
      { provider: "openrouter", model: "~openai/gpt-luna-latest", minTier: "quick" },
      { provider: "openrouter", model: "~z-ai/glm-flash-latest", minTier: "quick" },
    ],
    write: [
      { provider: "openrouter", model: "~google/gemini-flash-latest", minTier: "quick" },
      { provider: "openrouter", model: "openai/gpt-5.4-mini", minTier: "quick" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
  },
  kindMinimumTier: {
    chat: "quick",
    explain: "quick",
    write: "quick",
    operate: "standard",
    implement: "standard",
    debug: "standard",
    refactor: "standard",
    research: "standard",
    plan: "high",
    review: "high",
  },
  budget: {
    dailyUsd: undefined,
    monthlyUsd: undefined,
    softRatio: 0.7,
    hardRatio: 0.9,
  },
  cache: {
    aware: true,
    deadband: 0.25,
    maxPenaltyUsd: 0.05,
    bypassTierDelta: 2,
  },
  free: {
    enabled: false,
    policy: "prefer",
    pool: [],
  },
  taskKinds: { ...TASK_KINDS },
  confirm: {
    tiers: ["xpremium"],
    timeoutMs: 10000,
    onTimeout: "accept",
  },
  quota: {},
  recovery: { parkMs: 3600000 },
};

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function normalizeChain(value: unknown): RouteChain | undefined {
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  const targets = list.filter(
    (item): item is RouteTarget =>
      Boolean(item) && typeof item === "object" && typeof (item as RouteTarget).provider === "string" && typeof (item as RouteTarget).model === "string",
  );
  if (targets.length === 0) return undefined;
  return targets.map((t) => ({
    ...t,
    priority: t.priority === undefined || Number.isFinite(t.priority) ? t.priority : undefined,
    minQuota: t.minQuota === undefined ? undefined : normalizeQuotaFloors(t.minQuota),
  }));
}

/**
 * Deep-merge a patch onto the effective config. Ported from the legacy
 * `merge()`: chains replace per tier/kind, sub-objects merge per key.
 */
export function merge(base: JevRouterConfig, patch: unknown): JevRouterConfig {
  const p = readRecord(patch);
  const routes = { ...base.routes };
  const rawRoutes = readRecord(p.routes);
  for (const tier of TIERS) {
    const raw = rawRoutes[tier];
    const chain = Array.isArray(raw) && raw.length === 0 ? [] : normalizeChain(raw);
    if (chain) routes[tier] = chain;
  }
  const kindModels = { ...base.kindModels };
  for (const [kind, value] of Object.entries(readRecord(p.kindModels))) {
    const chain = Array.isArray(value) && value.length === 0 ? [] : normalizeChain(value);
    if (chain) kindModels[kind] = chain;
  }
  const taskKinds = { ...base.taskKinds };
  for (const [kind, value] of Object.entries(readRecord(p.taskKinds))) {
    if (typeof value === "string" && value.trim()) taskKinds[kind] = value;
  }
  const freePatch = readRecord(p.free);
  const freePool = normalizeChain(freePatch.pool);
  const free: FreePoolConfig = {
    enabled: typeof freePatch.enabled === "boolean" ? freePatch.enabled : base.free.enabled,
    policy: freePatch.policy === "prefer" || freePatch.policy === "fallback-only" ? freePatch.policy : base.free.policy,
    pool: freePool ?? base.free.pool,
  };
  const confirmPatch = readRecord(p.confirm);
  const confirmTiers = Array.isArray(confirmPatch.tiers)
    ? confirmPatch.tiers.filter((tier): tier is Tier => typeof tier === "string" && (TIERS as readonly string[]).includes(tier))
    : base.confirm.tiers;
  const confirm: ConfirmConfig = {
    tiers: confirmTiers,
    timeoutMs:
      typeof confirmPatch.timeoutMs === "number" && Number.isFinite(confirmPatch.timeoutMs) && confirmPatch.timeoutMs >= 0
        ? confirmPatch.timeoutMs
        : base.confirm.timeoutMs,
    onTimeout: confirmPatch.onTimeout === "accept" || confirmPatch.onTimeout === "reject" ? confirmPatch.onTimeout : base.confirm.onTimeout,
  };
  const recoveryPatch = readRecord(p.recovery);
  const recovery: JevRouterConfig["recovery"] = {
    parkMs:
      typeof recoveryPatch.parkMs === "number" && Number.isFinite(recoveryPatch.parkMs) && recoveryPatch.parkMs > 0
        ? recoveryPatch.parkMs
        : base.recovery.parkMs,
  };
  const quota = { ...base.quota };
  const rawCodex = readRecord(p.quota)["openai-codex"];
  if (rawCodex && typeof rawCodex === "object" && !Array.isArray(rawCodex)) {
    const patchRecord = readRecord(rawCodex);
    const previous = quota["openai-codex"];
    quota["openai-codex"] = {
      enabled: typeof patchRecord.enabled === "boolean" ? patchRecord.enabled : previous?.enabled ?? true,
      cacheTtlSec:
        typeof patchRecord.cacheTtlSec === "number" && Number.isFinite(patchRecord.cacheTtlSec) && patchRecord.cacheTtlSec >= 1 && patchRecord.cacheTtlSec <= 86400
          ? patchRecord.cacheTtlSec
          : previous?.cacheTtlSec ?? 120,
      onUnknown: patchRecord.onUnknown === "use" || patchRecord.onUnknown === "skip" ? patchRecord.onUnknown : previous?.onUnknown ?? "use",
      minQuota: { ...previous?.minQuota, ...normalizeQuotaFloors(patchRecord.minQuota) },
    };
  }
  return {
    ...base,
    ...(p as Partial<JevRouterConfig>),
    routes,
    kindModels,
    taskKinds,
    free,
    confirm,
    quota,
    recovery,
    budget: { ...base.budget, ...readRecord(p.budget) } as BudgetConfig,
    cache: { ...base.cache, ...readRecord(p.cache) } as CacheConfig,
    kindMinimumTier: {
      ...base.kindMinimumTier,
      ...(readRecord(p.kindMinimumTier) as Record<string, Tier>),
    },
  };
}

/**
 * Effective config from defaults + a profile patch + env (design §6).
 * `useDefaultModels: false` starts from empty chains (constitution §11);
 * the last source that sets it wins.
 */
export function effectiveConfig(profilePatch: unknown, env: NodeJS.ProcessEnv = process.env): JevRouterConfig {
  const explicit = readRecord(profilePatch).useDefaultModels;
  const useDefaults = typeof explicit === "boolean" ? explicit : DEFAULT_CONFIG.useDefaultModels;
  let config = useDefaults ? { ...DEFAULT_CONFIG } : { ...DEFAULT_CONFIG, routes: emptyChains(), kindModels: {} };
  config = merge(config, profilePatch);
  if (env.JEV_ROUTER_MODE) {
    const mode = env.JEV_ROUTER_MODE.toLowerCase();
    if (mode === "auto" || mode === "confirm" || mode === "notify") config.mode = mode;
  }
  if (env.JEV_ROUTER_OFF === "1" || env.JEV_ROUTER_OFF === "true") {
    config.enabled = false;
  }
  return config;
}

function emptyChains(): Record<Tier, RouteChain> {
  return { quick: [], standard: [], high: [], premium: [], xpremium: [] };
}

export function hasApiKey(config: JevRouterConfig): boolean {
  if (config.apiKey && config.apiKey.trim().length > 0) return true;
  const value = process.env[config.apiKeyEnv];
  return typeof value === "string" && value.trim().length > 0;
}

export function apiKeyFor(config: JevRouterConfig): string {
  return config.apiKey?.trim() || process.env[config.apiKeyEnv]?.trim() || "";
}

export function endpointFor(config: JevRouterConfig): string {
  return process.env[config.endpointEnv]?.trim() || config.endpoint;
}

/** Quota floors shared by every resolved openai-codex target. */
export function floorsFor(config: JevRouterConfig, target: RouteTarget): QuotaFloors {
  const codex = config.quota["openai-codex"];
  const floors: QuotaFloors = {};
  for (const window of QUOTA_WINDOWS) {
    const floor = Math.max(codex?.minQuota[window] ?? 0, target.minQuota?.[window] ?? 0);
    if (floor > 0) floors[window] = floor;
  }
  return floors;
}

/** Extract the routing-relevant fields of a profile (legacy switcher port). */
export function profileToRouterConfig(profile: JevProfile): Record<string, unknown> {
  const routerConfiguration: Record<string, unknown> = {};
  if (typeof profile.useDefaultModels === "boolean") routerConfiguration.useDefaultModels = profile.useDefaultModels;
  if (typeof profile.enabled === "boolean") routerConfiguration.enabled = profile.enabled;
  if (typeof profile.mode === "string") routerConfiguration.mode = profile.mode;
  if (typeof profile.apiKey === "string") routerConfiguration.apiKey = profile.apiKey;
  if (typeof profile.apiKeyEnv === "string") routerConfiguration.apiKeyEnv = profile.apiKeyEnv;
  if (typeof profile.endpoint === "string") routerConfiguration.endpoint = profile.endpoint;
  if (typeof profile.endpointEnv === "string") routerConfiguration.endpointEnv = profile.endpointEnv;
  if (typeof profile.jevModel === "string") routerConfiguration.jevModel = profile.jevModel;
  if (typeof profile.timeoutMs === "number") routerConfiguration.timeoutMs = profile.timeoutMs;
  if (typeof profile.minPromptChars === "number") routerConfiguration.minPromptChars = profile.minPromptChars;
  if (typeof profile.historyTurns === "number") routerConfiguration.historyTurns = profile.historyTurns;
  if (typeof profile.confidenceThreshold === "number") routerConfiguration.confidenceThreshold = profile.confidenceThreshold;
  if (typeof profile.stickiness === "boolean") routerConfiguration.stickiness = profile.stickiness;
  if (profile.routes) routerConfiguration.routes = profile.routes;
  if (profile.kindModels) routerConfiguration.kindModels = profile.kindModels;
  if (profile.kindMinimumTier) routerConfiguration.kindMinimumTier = profile.kindMinimumTier;
  if (profile.free) routerConfiguration.free = profile.free;
  if (profile.budget) routerConfiguration.budget = profile.budget;
  if (profile.cache) routerConfiguration.cache = profile.cache;
  if (profile.taskKinds) routerConfiguration.taskKinds = profile.taskKinds;
  if (profile.confirm) routerConfiguration.confirm = profile.confirm;
  if (profile.recovery) routerConfiguration.recovery = profile.recovery;
  if (profile.quota) routerConfiguration.quota = profile.quota;

  // Preserve any additional custom router properties.
  for (const [key, value] of Object.entries(profile)) {
    if (key !== "name" && key !== "description" && key !== "recommendedAccounts" && !(key in routerConfiguration)) {
      routerConfiguration[key] = value;
    }
  }
  return routerConfiguration;
}
