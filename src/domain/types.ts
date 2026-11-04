/**
 * Domain types for pi-jev-router-pro.
 *
 * Constitution §11: config shapes (`routes`, `kindModels`, tiers
 * `quick|standard|high|premium|xpremium`, `RouteTarget`, `free`, `budget`,
 * `cache`, `confirm`, `recovery`) stay compatible with the legacy
 * `pi-jev-model-router` schema. New pro knobs (`ProConfig`) are optional and
 * default to legacy-equivalent behavior.
 */

export type Tier = "quick" | "standard" | "high" | "premium" | "xpremium";
export const TIERS: readonly Tier[] = ["quick", "standard", "high", "premium", "xpremium"] as const;

export type Mode = "auto" | "confirm" | "notify";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RouteTarget {
  provider: string;
  model: string;
  /** Optional thinking level pinned for this model. Clamped by pi per model. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Only used inside `kindModels`: this model may serve the kind when the
   * chosen tier is at or above `minTier`. Defaults to "standard".
   */
  minTier?: Tier;
  /** Only used inside `kindModels`: higher wins among eligible specialists. Defaults to 0. */
  priority?: number;
  /** Minimum remaining account-quota ratios (0..1), currently Codex only. */
  minQuota?: QuotaFloors;
}

export const QUOTA_WINDOWS = ["fiveHour", "weekly"] as const;
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];
export type QuotaFloors = Partial<Record<QuotaWindow, number>>;

export interface CodexQuotaConfig {
  enabled: boolean;
  cacheTtlSec: number;
  onUnknown: "use" | "skip";
  /** Floors shared by every resolved openai-codex model. */
  minQuota: QuotaFloors;
}

/** Approval guard for switches into an expensive tier (constitution §9). */
export interface ConfirmConfig {
  /** Tiers that ask before switching. */
  tiers: Tier[];
  /** Dialog timeout in ms. `0` waits for an answer. */
  timeoutMs: number;
  /** What to do when the dialog times out or is dismissed without an answer. */
  onTimeout: "accept" | "reject";
}

/** A tier maps to an ordered candidate chain; the first available model wins (constitution §4). */
export type RouteChain = RouteTarget[];

export interface BudgetConfig {
  /** Rolling UTC-day spend cap in USD. Omit for no daily cap. */
  dailyUsd?: number;
  /** Calendar-month spend cap in USD. Omit for no monthly cap. */
  monthlyUsd?: number;
  /** Above this fraction of the cap, downgrade one tier. */
  softRatio: number;
  /** Above this fraction of the cap, force the cheapest tier. */
  hardRatio: number;
}

/**
 * Model switches invalidate the provider's prompt cache, so the next request
 * re-reads the whole prefix at full input price. These knobs keep the router
 * from paying that penalty for a marginal tier change (constitution §6).
 */
export interface CacheConfig {
  /** Master switch for cache/cost-aware hold decisions. */
  aware: boolean;
  /**
   * Demand must clear the current tier's band (tier ± 0.5) by this much before a
   * switch is considered. Damps flapping between adjacent tiers.
   */
  deadband: number;
  /** Skip a switch whose estimated cache penalty exceeds this many USD, unless it is a large upgrade. */
  maxPenaltyUsd: number;
  /** Tier jumps this large always switch, since they are quality-critical. */
  bypassTierDelta: number;
}

/**
 * Where a pool of zero-cost models sits relative to the tier chains.
 * - `prefer`: try the pool first, then the kind and tier chains.
 * - `fallback-only`: try the pool last, after every tier chain.
 */
export type FreePolicy = "prefer" | "fallback-only";

export interface FreePoolConfig {
  /** Master switch. When false the pool is ignored and routing is unchanged. */
  enabled: boolean;
  /** Whether the pool is tried before or after the tier chains. */
  policy: FreePolicy;
  /** Candidate chain, tried in order. The first available model wins. */
  pool: RouteChain;
}

export interface JevRouterConfig {
  enabled: boolean;
  mode: Mode;
  /**
   * When false, the built-in model chains (`routes`, `kindModels`) are dropped
   * entirely, so routing uses only the models your config provides (constitution §11).
   */
  useDefaultModels: boolean;
  apiKeyEnv: string;
  apiKey?: string;
  endpointEnv: string;
  endpoint: string;
  jevModel: string;
  timeoutMs: number;
  minPromptChars: number;
  /** How many recent conversation turns to include as Jev state. */
  historyTurns: number;
  /** Below this choice confidence, fall back to the safe tier. */
  confidenceThreshold: number;
  stickiness: boolean;
  routes: Record<Tier, RouteChain>;
  /**
   * Kind-specific model preferences. When a kind has a chain here, models are
   * tried before the generic tier chain (subject to `minTier`).
   */
  kindModels: Record<string, RouteChain>;
  /** Floor tier per task kind, so e.g. planning never lands on the quick model. */
  kindMinimumTier: Record<string, Tier>;
  free: FreePoolConfig;
  budget: BudgetConfig;
  cache: CacheConfig;
  taskKinds: Record<string, string>;
  confirm: ConfirmConfig;
  quota: { "openai-codex"?: CodexQuotaConfig };
  recovery: { parkMs: number };
}

export const TASK_KINDS: Record<string, string> = {
  plan: "Deciding what to build, sequencing work, or designing an approach before editing",
  implement: "Writing or changing code, scripts, or configuration to produce a concrete result",
  write: "Producing prose, documentation, comments, or other non-code content from scratch",
  debug: "Diagnosing a failure, error, or unexpected behavior and finding its root cause",
  refactor: "Restructuring existing code without changing intended behavior",
  review: "Auditing code, a diff, a document, or a plan for problems and risks",
  research: "Searching, reading, and synthesizing external information or unfamiliar APIs",
  explain: "Answering a question or explaining how something works",
  operate: "Running commands, tooling, git, deploys, or environment setup",
  chat: "Small talk, acknowledgements, or a request with no real work attached",
};

/**
 * A routing profile: a superset of the legacy router config (constitution §8).
 * Shape-compatible with values in the operator's existing
 * `pi-jev-model-router-profiles.json`.
 */
export interface JevProfile {
  name?: string;
  description?: string;
  useDefaultModels?: boolean;
  enabled?: boolean;
  mode?: Mode;
  apiKeyEnv?: string;
  apiKey?: string;
  endpointEnv?: string;
  endpoint?: string;
  jevModel?: string;
  timeoutMs?: number;
  minPromptChars?: number;
  historyTurns?: number;
  confidenceThreshold?: number;
  stickiness?: boolean;
  routes?: Partial<Record<Tier, RouteChain>>;
  kindModels?: Record<string, RouteChain>;
  kindMinimumTier?: Record<string, Tier>;
  free?: Partial<FreePoolConfig>;
  budget?: Partial<BudgetConfig>;
  cache?: Partial<CacheConfig>;
  taskKinds?: Record<string, string>;
  confirm?: Partial<ConfirmConfig>;
  recovery?: Partial<{ parkMs: number }>;
  quota?: { "openai-codex"?: Partial<CodexQuotaConfig> };
  /**
   * Optional mapping of provider names to recommended account IDs in
   * pi-account-switcher. Example: { "google": "google-personal" }
   */
  recommendedAccounts?: Record<string, string>;
  [key: string]: unknown;
}

export type ProfilesCollection = Record<string, JevProfile>;

/**
 * Pro-only knobs (design §6 step 3), read from `pi-jev-router-pro.json`.
 * Everything is optional and inert by default.
 */
export interface ProConfig {
  /** Virtual model registration surface (default provider `jev`, id `auto`). */
  virtual?: { provider?: string; id?: string; name?: string };
  /**
   * When false, the extension never auto-selects the virtual model at session
   * start and stays dormant until `/jev auto`.
   */
  dormancy?: boolean;
  /** Where the profiles file lives. Defaults to the legacy profiles file name. */
  profilesPath?: string;
  /**
   * Dev-only deterministic fallback verification (design §7). `firstTransient`
   * is the synthetic error text; the first `onRequest` routed dispatches fail
   * with it so the retry-advance path runs against the operator's real second
   * candidate. `mode: "advance"` skips the candidate without throwing (purely
   * cosmetic simulation); the default `"throw"` exercises pi's real retry.
   */
  faultInjection?: {
    firstTransient?: string;
    onRequest?: number;
    mode?: "throw" | "advance";
  };
}

/** Pro extension state (constitution §8: only our own state file is written). */
export interface ProState {
  version: 1;
  activeProfile?: string;
  lastSwitchedAt?: string;
  /** Persisted permanent-failure parking (constitution §5). */
  parks: ParkEntry[];
  ledger?: LedgerData;
}

export interface ParkEntry {
  key: string;
  until: number;
}

/** Spend ledger, shape-compatible with the legacy router's ledger format. */
export interface LedgerData {
  days: Record<string, { total: number; byModel: Record<string, number> }>;
  months: Record<string, { total: number; byModel: Record<string, number> }>;
  jev: { requests: number; inputTokens: number; outputTokens: number };
  updatedAt: string;
}

/**
 * Router state returned from `route()` and stored by pi on the session branch
 * (design §3). JSON-serializable; `attempted` resets at every `user` boundary.
 */
export interface RouterState {
  /** Physical `provider/model` keys already dispatched this turn. */
  attempted?: string[];
  /** Judgment that produced the current chain, reused on continuations. */
  lastJudgment?: StoredJudgment;
  /** Tier the chain was built from. */
  lastTier?: Tier;
  /** Task kind the chain was built from. */
  lastKind?: string;
}

/** JSON-safe subset of a Jev judgment kept in router state. */
export interface StoredJudgment {
  kind: string;
  kindConfidence: number;
  complexity: number;
  budgetIntensity: number;
  deepReasoning: number;
}
