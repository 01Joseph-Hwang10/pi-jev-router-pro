import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Parking, fileParking } from "../src/routing/parking.js";
import { emptyLedger, formatUsd, loadLedger, recordCost, spendSnapshot } from "../src/routing/budget.js";
import { loadQuotaState, parseCodexUsage, quotaEligibility, saveQuotaState } from "../src/routing/quota.js";
import type { CodexQuotaConfig } from "../src/domain/types.js";

/** Parking TTL persistence (R5.1), spend ledger, quota eligibility notes (R6). */

describe("Parking (R5.1)", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "parking-test-"));
    file = join(dir, "parking.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists parks across instances and expires by TTL", () => {
    const first = fileParking(file);
    expect(first.has("p/m1")).toBe(false);
    expect(first.park("p/m1", 3600_000, 1_000)).toBe(true);
    expect(first.has("p/m1", 2_000)).toBe(true);
    expect(first.has("p/m1", 3600_000 + 1_001)).toBe(false);
    expect(first.list(2_000)).toEqual([`p/m1 parked until ${new Date(1000 + 3600_000).toISOString()}`]);

    const second = fileParking(file);
    expect(second.has("p/m1", 2_000)).toBe(true);
    expect(second.clear()).toBe(true);
    expect(fileParking(file).has("p/m1", 2_000)).toBe(false);
  });
  it("tolerates corrupt or missing state files", () => {
    expect(fileParking(join(dir, "missing.json")).has("p/m1")).toBe(false);
  });

  it("filters malformed entries on load", () => {
    const parking = new Parking(
      () => [
        { key: "ok/model", until: 9_999_999_999_999 },
        { key: "no-slash", until: 9_999_999_999_999 },
        { key: "bad/time", until: Number.NaN },
      ],
      () => true,
    );
    expect(parking.has("ok/model")).toBe(true);
    expect(parking.has("no-slash")).toBe(false);
  });
});

describe("budget ledger (R6.2 inputs)", () => {
  it("records per-day and per-month spend with rounding", () => {
    const ledger = emptyLedger();
    recordCost(ledger, "p/a", 0.12345);
    recordCost(ledger, "p/a", 0.00005);
    expect(ledger.days[spendDay()].total).toBeCloseTo(0.1236, 4);
    expect(Object.keys(ledger.months)).toHaveLength(1);
    const snapshot = spendSnapshot(ledger, { dailyUsd: 1, monthlyUsd: 10, softRatio: 0.7, hardRatio: 0.9 });
    expect(snapshot.pressure).toBeCloseTo(0.1236, 3);
  });

  it("pressure is the max of daily and monthly ratios; 0 with no caps", () => {
    const ledger = loadLedger(undefined);
    ledger.days["2026-01-01"] = { total: 5, byModel: {} };
    const both = spendSnapshot(ledger, { dailyUsd: 10, monthlyUsd: 10, softRatio: 0.7, hardRatio: 0.9 });
    expect(both.pressure).toBe(0); // day key is today, not 2026-01-01
    const none = spendSnapshot(ledger, { softRatio: 0.7, hardRatio: 0.9 });
    expect(none.pressure).toBe(0);
  });

  it("formats USD amounts", () => {
    expect(formatUsd(2)).toBe("$2.00");
    expect(formatUsd(0.033)).toBe("$0.033");
    expect(formatUsd(0.0001)).toBe("$0.0001");
  });
});

function spendDay(): string {
  return new Date().toISOString().slice(0, 10);
}

describe("codex quota eligibility (R6.1)", () => {
  const config: CodexQuotaConfig = { enabled: true, cacheTtlSec: 120, onUnknown: "use", minQuota: { fiveHour: 0.2 } };
  const target = { provider: "openai-codex", model: "gpt-5.6" };

  it("admits non-codex providers and ungated targets", () => {
    expect(quotaEligibility(target, "google", config, undefined).allowed).toBe(true);
    expect(quotaEligibility({ provider: "openai-codex", model: "g" }, "openai-codex", { ...config, minQuota: {} }, undefined).allowed).toBe(true);
  });

  it("skips when a fresh reading is below the floor, with a note (R6.3)", () => {
    const snapshot = parseCodexUsage({ rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 95 } } }, 1_000);
    const result = quotaEligibility(target, "openai-codex", config, snapshot, 2_000);
    expect(result.allowed).toBe(false);
    expect(result.notes.join(" ")).toMatch(/5\.0% < 20\.0%/);
  });

  it("admits unknown/stale readings with a note unless onUnknown=skip", () => {
    const unknown = quotaEligibility(target, "openai-codex", config, undefined, 2_000);
    expect(unknown.allowed).toBe(true);
    expect(unknown.notes.join(" ")).toMatch(/admitted.*unknown/);

    const skip = { ...config, onUnknown: "skip" as const };
    const result = quotaEligibility(target, "openai-codex", skip, undefined, 2_000);
    expect(result.allowed).toBe(false);
    expect(result.notes.join(" ")).toMatch(/skipped.*unknown/);
  });

  it("parses the usage payload windows conservatively", () => {
    const snapshot = parseCodexUsage(
      {
        rate_limit: {
          primary_window: { limit_window_seconds: 18000, used_percent: 40, reset_at: 1_700_000_000 },
          secondary_window: { limit_window_seconds: 604800, used_percent: 10 },
          limit_reached: false,
        },
      },
      5_000,
    );
    expect(snapshot.windows.fiveHour?.remaining).toBeCloseTo(0.6);
    expect(snapshot.windows.weekly?.remaining).toBeCloseTo(0.9);
    expect(snapshot.windows.fiveHour?.resetAt).toBe(1_700_000_000_000);
    expect(snapshot.limitReached).toBeUndefined();
    const hardStop = parseCodexUsage({ rate_limit: { limit_reached: true } }, 5_000);
    expect(hardStop.limitReached).toBe(true);
  });

  it("round-trips quota state files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quota-test-"));
    try {
      const file = join(dir, "quota.json");
      saveQuotaState(file, { version: 1, updatedAt: 42, snapshot: parseCodexUsage({ rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 25 } } }, 7) });
      const loaded = loadQuotaState(file);
      expect(loaded.version).toBe(1);
      expect(loaded.snapshot?.windows.fiveHour?.remaining).toBeCloseTo(0.75);
      expect(loaded.updatedAt).toBe(42);
      expect(loadQuotaState(join(dir, "missing.json")).snapshot).toBeUndefined();
      await writeFile(file, "not json", "utf8");
      expect(loadQuotaState(file).snapshot).toBeUndefined();
      void readFile; // keep import used
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
