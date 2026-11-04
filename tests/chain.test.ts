import { describe, expect, it } from "vitest";
import { buildOrderedChain, cacheHold, estimateCachePenaltyUsd, firstAvailable, kindCandidates, tierForModel, type AvailableModel } from "../src/domain/chain.js";
import { effectiveConfig, DEFAULT_CONFIG } from "../src/jev/config.js";
import type { JevRouterConfig, RouteTarget } from "../src/domain/types.js";

/** R2.1 golden chains: free pool → kind specialists → tier chain → adjacent tiers. */
function testConfig(patch: Record<string, unknown> = {}): JevRouterConfig {
  return effectiveConfig({ useDefaultModels: false, ...patch });
}

const MODELS: AvailableModel[] = [
  { provider: "p", id: "free1", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  { provider: "p", id: "q1", cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02 } },
  { provider: "p", id: "s1", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } },
  { provider: "p", id: "s2", cost: { input: 1.5, output: 3, cacheRead: 0.1, cacheWrite: 0.2 } },
  { provider: "p", id: "h1", cost: { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 0.6 } },
  { provider: "p", id: "p1", cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 } },
  { provider: "p", id: "x1", cost: { input: 30, output: 60, cacheRead: 3, cacheWrite: 6 } },
];

describe("chain building (R2.1)", () => {
  const config = testConfig({
    routes: {
      quick: [{ provider: "p", model: "q1" }],
      standard: [
        { provider: "p", model: "s1" },
        { provider: "p", model: "s2" },
      ],
      high: [{ provider: "p", model: "h1" }],
      premium: [{ provider: "p", model: "p1" }],
      xpremium: [{ provider: "p", model: "x1" }],
    },
    kindModels: {
      implement: [{ provider: "p", model: "s1", minTier: "standard", priority: 1 }],
      plan: [{ provider: "p", model: "p1", minTier: "high" }],
    },
    free: { enabled: true, policy: "prefer", pool: [{ provider: "p", model: "free1" }] },
  });

  it("orders: free pool (prefer) → kind specialists → tier chain → adjacent tiers nearest-first", () => {
    // standard index = 1; adjacent: quick (−1) then high (+1), then premium (−2), xpremium (+2).
    const chain = buildOrderedChain(config, "implement", 1);
    const keys = chain.map((t) => `${t.provider}/${t.model}`);
    expect(keys[0]).toBe("p/free1"); // free pool prefer
    expect(keys[1]).toBe("p/s1"); // kind specialist eligible at standard
    expect(keys.slice(2, 4)).toEqual(["p/s1", "p/s2"]); // routes.standard
    expect(keys[4]).toBe("p/q1"); // −1
    expect(keys[5]).toBe("p/h1"); // +1
    expect(keys[6]).toBe("p/p1"); // −2
    expect(keys[7]).toBe("p/x1"); // +2 — xpremium included when configured
  });

  it("appends the free pool last under fallback-only", () => {
    const fallbackConfig = testConfig({
      routes: { quick: [{ provider: "p", model: "q1" }], standard: [{ provider: "p", model: "s1" }], high: [], premium: [], xpremium: [] },
      free: { enabled: true, policy: "fallback-only", pool: [{ provider: "p", model: "free1" }] },
    });
    const chain = buildOrderedChain(fallbackConfig, "chat", 1);
    expect(chain.at(-1)).toEqual({ provider: "p", model: "free1" });
  });

  it("never includes unconfigured tiers, and xpremium only when configured (R2.4)", () => {
    const noXp = testConfig({
      routes: { quick: [{ provider: "p", model: "q1" }], standard: [], high: [{ provider: "p", model: "h1" }], premium: [], xpremium: [] },
    });
    const chain = buildOrderedChain(noXp, "chat", 1);
    const keys = chain.map((t) => `${t.provider}/${t.model}`);
    expect(keys).toEqual(["p/q1", "p/h1"]); // standard empty → skipped, adjacent −1/+1
  });

  it("sorts kind specialists by priority desc, then minTier closeness", () => {
    const cfg = testConfig({
      routes: { quick: [], standard: [], high: [], premium: [], xpremium: [] },
      kindModels: {
        review: [
          { provider: "p", model: "s1", minTier: "standard" },
          { provider: "p", model: "p1", minTier: "high", priority: 5 },
          { provider: "p", model: "h1", minTier: "high" },
        ],
      },
    });
    expect(kindCandidates(cfg, "review", 2).map((t) => t.model)).toEqual(["p1", "h1", "s1"]);
    // Below the specialist's minTier the entry is filtered out.
    expect(kindCandidates(cfg, "review", 0)).toEqual([]);
  });

  it("resolves the first available + eligible target with notes (constitution §4)", () => {
    const notes: string[] = [];
    const picked = firstAvailable(
      MODELS,
      [
        { provider: "p", model: "ghost" }, // not in catalog
        { provider: "p", model: "s2" }, // blocked by eligibility
        { provider: "p", model: "s1" },
      ],
      (target) => (target.model === "s2" ? { allowed: false, notes: ["s2 skipped: parked"] } : { allowed: true, notes: [] }),
      notes,
    );
    expect(picked?.target.model).toBe("s1");
    expect(notes).toContain("s2 skipped: parked");
  });

  it("reverse-maps models to tiers via routes then kind chains", () => {
    const cfg = testConfig({
      routes: { quick: [{ provider: "p", model: "q1" }], standard: [{ provider: "p", model: "s1" }], high: [], premium: [], xpremium: [] },
      kindModels: { plan: [{ provider: "p", model: "p1", minTier: "premium" }] },
    });
    expect(tierForModel("p/q1", cfg)).toBe(0);
    expect(tierForModel("p/p1", cfg)).toBe(3);
    expect(tierForModel("p/unknown", cfg)).toBeUndefined();
  });
});

describe("cache-aware hold (R3.2)", () => {
  const config = testConfig({
    cache: { aware: true, deadband: 0.25, maxPenaltyUsd: 0.05, bypassTierDelta: 2 },
    routes: {
      quick: [{ provider: "p", model: "q1" }],
      standard: [{ provider: "p", model: "s1" }],
      high: [{ provider: "p", model: "h1" }],
      premium: [{ provider: "p", model: "p1" }],
      xpremium: [],
    },
  });

  const current: AvailableModel = MODELS.find((m) => m.id === "s1")!;
  const target: AvailableModel = MODELS.find((m) => m.id === "h1")!;

  it("estimates the cache penalty from context size and pricing", () => {
    const penalty = estimateCachePenaltyUsd(100_000, current, target);
    // cold (3 + 0.6)/1M − warm 0.1/1M per token × 100k = 35 cents.
    expect(penalty).toBeCloseTo(0.35, 5);
    expect(estimateCachePenaltyUsd(0, current, target)).toBe(0);
    expect(estimateCachePenaltyUsd(100_000, current, { provider: "p", id: "noprice" })).toBe(0);
  });

  it("holds when demand sits inside the current tier band", () => {
    const notes: string[] = [];
    const hold = cacheHold({
      config,
      demand: 1.1, // standard band ±0.5+deadband = up to 1.75
      desiredIndex: 2,
      index: 2,
      available: { target: { provider: "p", model: "h1" }, model: target },
      current: { index: 1, model: current, target: { provider: "p", model: "s1" } },
      contextTokens: 100_000,
      notes,
      spend: { today: 0, month: 0, pressure: 0 },
    });
    expect(hold?.hold).toBe(true);
    expect(notes.join(" ")).toMatch(/inside the standard band/);
  });

  it("allows a large upgrade despite the penalty", () => {
    const hold = cacheHold({
      config,
      demand: 2.8,
      desiredIndex: 3,
      index: 3,
      available: { target: { provider: "p", model: "p1" }, model: MODELS.find((m) => m.id === "p1")! },
      current: { index: 0, model: MODELS.find((m) => m.id === "q1")!, target: { provider: "p", model: "q1" } },
      contextTokens: 100_000,
      notes: [],
      spend: { today: 0, month: 0, pressure: 0 },
    });
    expect(hold).toBeUndefined(); // delta 3 ≥ bypassTierDelta 2 → always switch
  });

  it("never holds when cache awareness is off or models match", () => {
    const off = { ...config, cache: { ...config.cache, aware: false } };
    expect(
      cacheHold({
        config: off,
        demand: 1.1,
        desiredIndex: 2,
        index: 2,
        available: { target: { provider: "p", model: "h1" }, model: target },
        current: { index: 1, model: current, target: { provider: "p", model: "s1" } },
        contextTokens: 100_000,
        notes: [],
        spend: { today: 0, month: 0, pressure: 0 },
      }),
    ).toBeUndefined();
    expect(
      cacheHold({
        config,
        demand: 1.1,
        desiredIndex: 2,
        index: 2,
        available: { target: { provider: "p", model: "s1" }, model: current },
        current: { index: 1, model: current, target: { provider: "p", model: "s1" } },
        contextTokens: 100_000,
        notes: [],
        spend: { today: 0, month: 0, pressure: 0 },
      }),
    ).toBeUndefined();
  });
});

describe("built-in defaults keep legacy shape (constitution §11)", () => {
  it("keeps every tier key incl. xpremium and the default knobs", () => {
    const tiers = Object.keys(DEFAULT_CONFIG.routes).sort();
    expect(tiers).toEqual(["high", "premium", "quick", "standard", "xpremium"]);
    expect(DEFAULT_CONFIG.budget.softRatio).toBe(0.7);
    expect(DEFAULT_CONFIG.budget.hardRatio).toBe(0.9);
    expect(DEFAULT_CONFIG.cache.deadband).toBe(0.25);
    expect(DEFAULT_CONFIG.free.policy).toBe("prefer");
    expect(DEFAULT_CONFIG.recovery.parkMs).toBe(3_600_000);
    expect(DEFAULT_CONFIG.mode).toBe("auto");
  });

  it("drops built-ins entirely under useDefaultModels:false (R2.4)", () => {
    const config = testConfig();
    expect(config.routes.quick).toEqual([]);
    expect(config.kindModels).toEqual({});
    expect(config.taskKinds).toBeDefined();
  });

  it("normalizes chain entries from raw profile JSON", () => {
    const config = testConfig({
      routes: { quick: [{ provider: "p", model: "q1", minQuota: { fiveHour: 0.4, bogus: 5 } }] },
    } as Record<string, unknown>);
    const target: RouteTarget | undefined = config.routes.quick[0];
    expect(target?.minQuota).toEqual({ fiveHour: 0.4 });
  });
});
