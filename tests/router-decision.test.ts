import { describe, expect, it } from "vitest";
import { resolveRoute, computeTier, type RouteEnvironment, type RouteInput } from "../src/routing/router.js";
import { effectiveConfig } from "../src/jev/config.js";
import type { AvailableModel } from "../src/domain/chain.js";
import type { JevRouterConfig, StoredJudgment } from "../src/domain/types.js";
import type { RouteAnalysis as JevAnalysis } from "../src/jev/client.js";

/**
 * The route() decision table (design §3) verified offline with mock
 * ModelRouteRequest-shaped inputs (design §7).
 */

function jev(partial: Partial<JevAnalysis>): JevAnalysis {
  return {
    kind: "implement",
    kindConfidence: 0.9,
    kindProbabilities: { implement: 0.9 },
    complexity: 1,
    complexityConfidence: 0.8,
    budgetIntensity: 1,
    budgetIntensityConfidence: 0.8,
    deepReasoning: 0.2,
    latencyMs: 5,
    ...partial,
  };
}

function stored(judgment: JevAnalysis): StoredJudgment {
  return { kind: judgment.kind, kindConfidence: judgment.kindConfidence, complexity: judgment.complexity, budgetIntensity: judgment.budgetIntensity, deepReasoning: judgment.deepReasoning };
}

const MODELS: AvailableModel[] = [
  { provider: "p", id: "q1" },
  { provider: "p", id: "s1" },
  { provider: "p", id: "s2" },
  { provider: "p", id: "h1" },
  { provider: "p", id: "p1" },
  { provider: "p", id: "x1" },
];

function config(patch: Record<string, unknown> = {}): JevRouterConfig {
  return effectiveConfig({
    useDefaultModels: false,
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
    ...patch,
  });
}

function env(overrides: Partial<RouteEnvironment> & { analysis?: JevAnalysis | Error; config?: JevRouterConfig; parked?: string[]; quotaBlocked?: string[] } = {}): RouteEnvironment {
  const parked = new Set(overrides.parked ?? []);
  const quotaBlocked = new Set(overrides.quotaBlocked ?? []);
  return {
    config: overrides.config ?? config(),
    models: MODELS,
    spend: { today: 0, month: 0, pressure: 0 },
    eligibility: (target) => {
      const key = `${target.provider}/${target.model}`;
      if (parked.has(key)) return { allowed: false, notes: [`${key} skipped: model temporarily parked`] };
      if (quotaBlocked.has(key)) return { allowed: false, notes: [`${key} skipped: quota`] };
      return { allowed: true, notes: [] };
    },
    classify: async () => {
      const analysis = overrides.analysis;
      if (analysis instanceof Error) throw analysis;
      return analysis ?? jev({});
    },
    park: (key) => parked.add(key),
    notify: overrides.notify,
    confirmSwitch: overrides.confirmSwitch,
    ...overrides,
  };
}

function userInput(partial: Partial<RouteInput> = {}): RouteInput {
  return { reason: "user", thinkingLevel: "medium", prompt: "implement a thing", ...partial };
}

describe("reason=user (R2)", () => {
  it("dispatches the first eligible chain entry: kind specialist wins at standard (R2.1)", async () => {
    const result = await resolveRoute(userInput(), env({ analysis: jev({ kind: "implement", complexity: 1, budgetIntensity: 1 }) }));
    expect(result.route).toMatchObject({ provider: "p", id: "s1" });
    expect(result.decision.tier).toBe("standard");
    expect(result.decision.kindSpecialised).toBe(true);
    // R2.2: the decision carries the judgment summary for the entry.
    expect(result.decision.analysis).toEqual(stored(jev({ kind: "implement" })));
  });

  it("falls through the kind specialist to the tier chain when it is ineligible", async () => {
    const result = await resolveRoute(userInput(), env({ analysis: jev({ kind: "implement" }), quotaBlocked: ["p/s1"] }));
    expect(result.route.id).toBe("s2"); // routes.standard[0]
    expect(result.decision.notes.join(" ")).toContain("quota");
  });

  it("hits the adjacent tier when the whole judged tier chain is unavailable", async () => {
    const result = await resolveRoute(userInput(), env({ analysis: jev({ kind: "chat" }), quotaBlocked: ["p/q1", "p/s1", "p/s2"] }));
    expect(result.route.id).toBe("h1"); // quick unavailable → +1
    expect(result.decision.notes.join(" ")).toContain("quota");
  });

  it("never invents models when nothing is configured (R2.4)", async () => {
    const empty = env({ config: config({ routes: { quick: [], standard: [], high: [], premium: [], xpremium: [] }, kindModels: {} }), analysis: jev({}) });
    await expect(resolveRoute(userInput(), empty)).rejects.toThrow(/no eligible configured route/);
  });

  it("stays sticky on Jev failure with a previous model (R2.3)", async () => {
    const boom = new Error("missing API key");
    const result = await resolveRoute(
      userInput({ previous: { provider: "p", id: "h1", thinkingLevel: "medium" } }),
      env({ analysis: boom, notify: () => {} }),
    );
    expect(result.route).toMatchObject({ provider: "p", id: "h1" });
    expect(result.decision.warnOnly).toBe(true);
  });

  it("falls open to the first configured candidate when Jev fails with no previous (R2.3)", async () => {
    const result = await resolveRoute(userInput(), env({ analysis: new Error("timeout"), notify: () => {} }));
    expect(result.route.id).toBe("s1"); // kind implement → s1 at standard
  });

  it("drops to standard below the confidence threshold", async () => {
    const cfg = config({ confidenceThreshold: 0.5 });
    const result = await resolveRoute(userInput(), env({ analysis: jev({ kind: "plan", kindConfidence: 0.2, complexity: 3, budgetIntensity: 3 }), config: cfg }));
    expect(result.decision.tier).toBe("standard");
    expect(result.decision.lowConfidenceFallback).toBe(true);
    expect(result.decision.notes.join(" ")).toMatch(/low kind confidence/);
  });

  it("caps the tier under hard budget pressure, one tier down under soft (R6.2)", async () => {
    // demand ≈ 2.75 (architectural) → hard pressure caps at standard, not quick.
    const hard = env({ analysis: jev({ kind: "plan", complexity: 3, budgetIntensity: 3 }), spend: { today: 95, month: 0, pressure: 0.95 } });
    const hardResult = await resolveRoute(userInput(), hard);
    expect(hardResult.decision.tier).toBe("standard");
    expect(hardResult.decision.downgraded).toBe(true);
    expect(hardResult.decision.notes.join(" ")).toMatch(/capped at standard/);

    const soft = env({ analysis: jev({ kind: "plan", complexity: 2.6, budgetIntensity: 2.5, deepReasoning: 0.8 }), spend: { today: 75, month: 0, pressure: 0.75 } });
    const softResult = await resolveRoute(userInput(), soft);
    expect(softResult.decision.downgraded).toBe(true);
    expect(softResult.decision.notes.join(" ")).toMatch(/one tier down|capped at/);
  });

  it("reaches xpremium only with configured chain + confidence + premium demand", async () => {
    const result = await resolveRoute(userInput(), env({ analysis: jev({ kind: "plan", complexity: 3, budgetIntensity: 3, kindConfidence: 0.9, deepReasoning: 0.9 }) }));
    expect(result.decision.tier).toBe("xpremium");
    // The plan specialist (minTier high) still leads the chain at xpremium.
    expect(result.route.id).toBe("p1");
    expect(result.decision.kindSpecialised).toBe(true);

    const noXp = config({ routes: { quick: [{ provider: "p", model: "q1" }], standard: [{ provider: "p", model: "s1" }], high: [{ provider: "p", model: "h1" }], premium: [{ provider: "p", model: "p1" }], xpremium: [] } });
    const capped = await resolveRoute(userInput(), env({ analysis: jev({ kind: "plan", complexity: 3, budgetIntensity: 3, kindConfidence: 0.9 }), config: noXp }));
    expect(capped.decision.tier).toBe("premium");
  });

  it("holds a marginal tier move inside the cache deadband (R3.2)", async () => {
    // chat has no kind specialists in this config, so the chain is the tier chain.
    const first = await resolveRoute(userInput({ prompt: "hello there" }), env({ analysis: jev({ kind: "chat", complexity: 1, budgetIntensity: 1 }) }));
    expect(first.route.id).toBe("s1"); // standard
    // demand 1.75 → high, but 1.75 sits on the band edge (1 + 0.5 + 0.25) → held.
    const second = await resolveRoute(
      userInput({ prompt: "now something harder", previous: { provider: "p", id: "s1", thinkingLevel: "medium" }, contextTokens: 50_000 }),
      env({ analysis: jev({ kind: "chat", complexity: 2, budgetIntensity: 2 }) }),
    );
    expect(second.decision.held).toBe(true);
    expect(second.route.id).toBe("s1");
    expect(second.decision.notes.join(" ")).toMatch(/band/);
  });
});

describe("reason=continuation (R3.1)", () => {
  it("stays sticky on the previous eligible model", async () => {
    const result = await resolveRoute(
      { reason: "continuation", thinkingLevel: "medium", previous: { provider: "p", id: "s1", thinkingLevel: "low" }, state: { attempted: ["p/s1"], lastJudgment: stored(jev({})) } },
      env(),
    );
    expect(result.route).toMatchObject({ provider: "p", id: "s1" });
    expect(result.decision.action).toBe("kept");
    expect(result.state).toEqual({ attempted: ["p/s1"], lastJudgment: stored(jev({})) });
  });

  it("re-resolves without re-classifying when the previous model became ineligible", async () => {
    const result = await resolveRoute(
      { reason: "continuation", thinkingLevel: "medium", previous: { provider: "p", id: "s1" }, state: { attempted: ["p/s1"], lastJudgment: stored(jev({})), lastTier: "standard", lastKind: "implement" } },
      env({ parked: ["p/s1"], quotaBlocked: ["p/s2"] }),
    );
    // s1 parked, s2 quota-blocked, adjacent tier quick → q1.
    expect(result.route.id).toBe("q1");
    expect(result.decision.notes.join(" ")).toContain("parked");
  });
});

describe("reason=retry (R4, R5)", () => {
  const baseState = { attempted: ["p/s1"], lastJudgment: stored(jev({})), lastTier: "standard" as const, lastKind: "implement" };

  it("advances the chain past the failed target on a transient error (R4.1)", async () => {
    const result = await resolveRoute(
      { reason: "retry", thinkingLevel: "medium", failed: { model: { provider: "p", id: "s1" }, message: { stopReason: "error", errorMessage: "HTTP 429 too many requests" } }, state: baseState },
      env(),
    );
    expect(result.decision.action).toBe("fallback");
    expect(result.decision.failure?.kind).toBe("transient");
    expect(result.route.id).toBe("s2");
    expect(result.state.attempted).toEqual(["p/s1", "p/s2"]);
  });

  it("grows state.attempted monotonically across further retries (R4.2)", async () => {
    const first = await resolveRoute(
      { reason: "retry", thinkingLevel: "medium", failed: { model: { provider: "p", id: "s1" }, message: { stopReason: "error", errorMessage: "500 server error" } }, state: baseState },
      env(),
    );
    const second = await resolveRoute(
      {
        reason: "retry",
        thinkingLevel: "medium",
        failed: { model: { provider: "p", id: "s2" }, message: { stopReason: "error", errorMessage: "503 service unavailable" } },
        state: first.state,
      },
      env(),
    );
    expect(second.route.id).toBe("q1"); // adjacent tier
    expect(second.state.attempted).toEqual(["p/s1", "p/s2", "p/q1"]);
  });

  it("parks permanent failures and advances (R5.1)", async () => {
    const parkedKeys: string[] = [];
    const result = await resolveRoute(
      {
        reason: "retry",
        thinkingLevel: "medium",
        failed: { model: { provider: "p", id: "s1" }, message: { stopReason: "error", errorMessage: "model s1 has been retired by the provider" } },
        state: baseState,
      },
      env({ park: (key) => parkedKeys.push(key) }),
    );
    expect(parkedKeys).toEqual(["p/s1"]);
    expect(result.route.id).toBe("s2");
    expect(result.decision.failure?.kind).toBe("permanent");
  });

  it("advances on unknown failures without parking (constitution §4 fail-open)", async () => {
    const parkedKeys: string[] = [];
    const result = await resolveRoute(
      { reason: "retry", thinkingLevel: "medium", failed: { model: { provider: "p", id: "s1" }, message: { stopReason: "error", errorMessage: "something odd" } }, state: baseState },
      env({ park: (key) => parkedKeys.push(key) }),
    );
    expect(parkedKeys).toEqual([]);
    expect(result.route.id).toBe("s2");
  });

  it("stays sticky on context overflow (R4.5)", async () => {
    const result = await resolveRoute(
      {
        reason: "retry",
        thinkingLevel: "medium",
        previous: { provider: "p", id: "s1" },
        failed: { model: { provider: "p", id: "s1" }, message: { stopReason: "error", errorMessage: "prompt is too long: context length exceeded" } },
        state: baseState,
      },
      env(),
    );
    expect(result.route.id).toBe("s1");
    expect(result.decision.reason).toMatch(/compaction recovery/);
    expect(result.decision.failure?.kind).toBe("overflow");
  });

  it("throws exactly on exhaustion — single-entry chain, transient (R4.4)", async () => {
    const single = env({ config: config({ routes: { quick: [{ provider: "p", model: "s1" }], standard: [], high: [], premium: [], xpremium: [] }, kindModels: {} }) });
    const afterUser = { attempted: ["p/s1"], lastJudgment: stored(jev({})), lastTier: "standard" as const };
    await expect(
      resolveRoute(
        { reason: "retry", thinkingLevel: "medium", failed: { model: { provider: "p", id: "s1" }, message: { stopReason: "error", errorMessage: "429" } }, state: afterUser },
        single,
      ),
    ).rejects.toThrow(/chain exhausted/);
  });

  it("honors confirm.tiers on fallback switches (R10.1)", async () => {
    let asked = 0;
    const result = await resolveRoute(
      {
        reason: "retry",
        thinkingLevel: "medium",
        failed: { model: { provider: "p", id: "p1" }, message: { stopReason: "error", errorMessage: "429" } },
        state: { attempted: ["p/p1"], lastJudgment: stored(jev({ kind: "plan" })), lastTier: "premium" as const, lastKind: "plan" },
      },
      env({
        config: config({ mode: "confirm", confirm: { tiers: ["high"], timeoutMs: 0, onTimeout: "reject" } }),
        confirmSwitch: async () => {
          asked += 1;
          return true;
        },
      }),
    );
    expect(asked).toBe(1); // fallback lands on high (adjacent) → guarded tier asked once
    expect(result.route.id).toBe("h1");
  });
});

describe("reason=direct (R7.1)", () => {
  it("dispatches the cheapest healthy target and writes no state", async () => {
    const result = await resolveRoute({ reason: "direct", thinkingLevel: "medium" }, env());
    expect(result.route.id).toBe("q1");
    expect(result.decision.reason).toMatch(/direct request/);
  });

  it("honors a configured direct target override", async () => {
    const result = await resolveRoute({ reason: "direct", thinkingLevel: "medium" }, env({ directTarget: { provider: "p", model: "s1" } }));
    expect(result.route.id).toBe("s1");
  });
});

describe("consent modes (R10.1)", () => {
  const planJudgment = jev({ kind: "plan", complexity: 3, budgetIntensity: 3, deepReasoning: 0.9 });

  it("auto switches silently (R10.1)", async () => {
    let asked = 0;
    const result = await resolveRoute(
      userInput(),
      env({
        analysis: planJudgment,
        config: config({ mode: "auto", confirm: { tiers: ["xpremium"], timeoutMs: 0, onTimeout: "accept" } }),
        confirmSwitch: async () => {
          asked += 1;
          return false;
        },
      }),
    );
    expect(asked).toBe(0);
    expect(result.decision.action).toBe("switched");
  });

  it("confirm prompts before the switch and keeps the current model on decline", async () => {
    let asked = 0;
    const declined = await resolveRoute(
      userInput({ previous: { provider: "p", id: "s1" } }),
      env({
        analysis: planJudgment,
        config: config({ mode: "confirm" }),
        confirmSwitch: async () => {
          asked += 1;
          return false;
        },
      }),
    );
    expect(asked).toBe(1);
    expect(declined.decision.action).toBe("skipped");
    expect(declined.route.id).toBe("s1");

    const accepted = await resolveRoute(
      userInput({ previous: { provider: "p", id: "s1" } }),
      env({
        analysis: planJudgment,
        config: config({ mode: "confirm" }),
        confirmSwitch: async () => {
          asked += 1;
          return true;
        },
      }),
    );
    expect(asked).toBe(2);
    expect(accepted.decision.action).toBe("switched");
    expect(accepted.decision.tier).toBe("xpremium");
  });

  it("notify never switches: dispatches the current model and reports (R10.1)", async () => {
    const result = await resolveRoute(
      userInput({ previous: { provider: "p", id: "s1" } }),
      env({ analysis: planJudgment, config: config({ mode: "notify" }), notify: () => {} }),
    );
    expect(result.decision.action).toBe("notified");
    expect(result.route.id).toBe("s1");
  });
});

describe("computeTier judgment math", () => {
  const cfg = config();
  const noSpend = { today: 0, month: 0, pressure: 0 };

  it("weights complexity 0.55 / capability 0.45 and floors by kind", () => {
    // implement floors at standard.
    const result = computeTier({ kind: "implement", kindConfidence: 0.9, complexity: 0, budgetIntensity: 0, deepReasoning: 0 }, cfg, noSpend, []);
    expect(result.demand).toBe(1); // floored up to the implement kind floor
    expect(result.index).toBe(1); // kind floor standard
    expect(result.desiredIndex).toBe(1);
  });

  it("nudges demand for deep reasoning", () => {
    const boosted = computeTier({ kind: "chat", kindConfidence: 0.9, complexity: 2, budgetIntensity: 2, deepReasoning: 0.8 }, cfg, noSpend, []);
    const plain = computeTier({ kind: "chat", kindConfidence: 0.9, complexity: 2, budgetIntensity: 2, deepReasoning: 0.1 }, cfg, noSpend, []);
    expect(boosted.demand).toBeGreaterThan(plain.demand);
    expect(boosted.index).toBeGreaterThan(plain.index);
  });
});
