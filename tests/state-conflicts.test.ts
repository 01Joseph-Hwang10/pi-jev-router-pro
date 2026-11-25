import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProState, saveProState, saveActiveProfileName, mergeAndSaveState } from "../src/profiles/state.js";
import type { LedgerData, ProState } from "../src/domain/types.js";

/** Self-healing merge of Syncthing conflict copies of the pro state file. */

function ledgerWith(days: LedgerData["days"], jev: LedgerData["jev"]): LedgerData {
  return { days, months: {}, jev, updatedAt: "2026-11-19T02:00:00.000Z" };
}

function stateWith(partial: Partial<ProState>): ProState {
  return { version: 1, parks: [], ...partial };
}

describe("loadProState sync-conflict healing", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "state-conflicts-test-"));
    statePath = join(dir, "pi-jev-router-pro-state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("recovers ledger spend that only a losing copy holds", async () => {
    await saveProState(statePath, stateWith({
      activeProfile: "zai",
      lastSwitchedAt: "2026-11-19T02:23:36.478Z",
      ledger: ledgerWith(
        { "2026-11-19": { total: 4.8071, byModel: { "zai/glm-5.3": 0.5989 } } },
        { requests: 10, inputTokens: 100, outputTokens: 200 },
      ),
    }));
    const copyPath = join(dir, "pi-jev-router-pro-state.sync-conflict-20261119-200429-B6UWKUB.json");
    await writeFile(
      copyPath,
      JSON.stringify(stateWith({
        activeProfile: "zai",
        lastSwitchedAt: "2026-11-19T02:23:36.478Z",
        ledger: ledgerWith(
          { "2026-11-19": { total: 5.0287, byModel: { "zai/glm-5.3": 1.6087, "zai-coding-cn/glm-5.3-flash": 0.2209 } } },
          { requests: 12, inputTokens: 90, outputTokens: 260 },
        ),
      })),
      "utf8",
    );

    const state = await loadProState(statePath);

    const day = state.ledger?.days["2026-11-19"];
    expect(day?.byModel["zai/glm-5.3"]).toBe(1.6087);
    expect(day?.byModel["zai-coding-cn/glm-5.3-flash"]).toBe(0.2209);
    // total is the sum of byModel (recordCost invariant)
    expect(day?.total).toBe(1.8296);
    // jev counters merge by max, not sum: never over-report spend
    expect(state.ledger?.jev).toEqual({ requests: 12, inputTokens: 100, outputTokens: 260 });
    // copy consumed, merged state persisted
    expect(await readdir(dir)).toEqual(["pi-jev-router-pro-state.json"]);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as ProState;
    expect(persisted.ledger?.days["2026-11-19"]?.total).toBe(1.8296);
  });

  it("unions days and parks and takes the newest profile switch", async () => {
    await saveProState(statePath, stateWith({
      activeProfile: "old",
      lastSwitchedAt: "2026-11-17T05:05:12.851Z",
      parks: [{ key: "p/stale", until: 1000 }, { key: "p/shared", until: 2000 }],
      ledger: ledgerWith({ "2026-11-04": { total: 1, byModel: { "a/b": 1 } } }, { requests: 1, inputTokens: 0, outputTokens: 0 }),
    }));
    const copyPath = join(dir, "pi-jev-router-pro-state.sync-conflict-20261119-150311-ADY4Y6L.json");
    await writeFile(
      copyPath,
      JSON.stringify(stateWith({
        activeProfile: "new",
        lastSwitchedAt: "2026-11-19T15:03:11.000Z",
        parks: [{ key: "p/shared", until: 3000 }, { key: "p/extra", until: 4000 }],
        ledger: ledgerWith({ "2026-11-05": { total: 2, byModel: { "c/d": 2 } } }, { requests: 2, inputTokens: 0, outputTokens: 0 }),
      })),
      "utf8",
    );

    const state = await loadProState(statePath);

    expect(state.activeProfile).toBe("new");
    expect(state.lastSwitchedAt).toBe("2026-11-19T15:03:11.000Z");
    expect(state.parks).toEqual([
      { key: "p/stale", until: 1000 },
      { key: "p/shared", until: 3000 },
      { key: "p/extra", until: 4000 },
    ]);
    expect(Object.keys(state.ledger?.days ?? {}).sort()).toEqual(["2026-11-04", "2026-11-05"]);
  });

  it("deletes corrupt copies and keeps an older active profile when the copy is older", async () => {
    await saveProState(statePath, stateWith({
      activeProfile: "current",
      lastSwitchedAt: "2026-11-19T02:23:36.478Z",
    }));
    const corruptPath = join(dir, "pi-jev-router-pro-state.sync-conflict-20261118-165744-ADY4Y6L.json");
    await writeFile(corruptPath, "{ not json", "utf8");

    const state = await loadProState(statePath);

    expect(state.activeProfile).toBe("current");
    expect(await readdir(dir)).toEqual(["pi-jev-router-pro-state.json"]);
  });

  it("ignores conflict copies of other files", async () => {
    await saveProState(statePath, stateWith({ activeProfile: "zai" }));
    const otherPath = join(dir, "other.json.sync-conflict-20261119-150311-ADY4Y6L.json");
    await writeFile(otherPath, "{}", "utf8");

    const state = await loadProState(statePath);

    expect(state.activeProfile).toBe("zai");
    expect((await readdir(dir)).sort()).toEqual([
      "other.json.sync-conflict-20261119-150311-ADY4Y6L.json",
      "pi-jev-router-pro-state.json",
    ]);
  });
});

describe("mergeAndSaveState (change 003)", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "merge-save-test-"));
    statePath = join(dir, "pi-jev-router-pro-state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the on-disk spend and the newer on-disk switch", async () => {
    await saveProState(statePath, stateWith({
      activeProfile: "zai",
      lastSwitchedAt: "2026-11-19T15:03:11.000Z",
      ledger: ledgerWith({ "2026-11-19": { total: 5, byModel: { "zai/glm-5.3": 5 } } }, { requests: 9, inputTokens: 1, outputTokens: 2 }),
    }));
    const incoming = stateWith({
      activeProfile: "stale",
      lastSwitchedAt: "2026-11-17T05:05:12.851Z",
      ledger: ledgerWith({ "2026-11-23": { total: 3, byModel: { "google/gemini": 3 } } }, { requests: 4, inputTokens: 0, outputTokens: 0 }),
    });

    const merged = await mergeAndSaveState(statePath, incoming);

    expect(merged.activeProfile).toBe("zai");
    expect(merged.ledger?.days["2026-11-19"]?.total).toBe(5);
    expect(merged.ledger?.days["2026-11-23"]?.total).toBe(3);
    expect(merged.ledger?.jev.requests).toBe(9);
    expect((await loadProState(statePath)).ledger?.days["2026-11-23"]?.total).toBe(3);
  });

  it("treats a missing or corrupt file as empty and leaves no .tmp siblings", async () => {
    await writeFile(statePath, "{ corrupt", "utf8");
    const incoming = stateWith({
      activeProfile: "zai",
      ledger: ledgerWith({ "2026-11-23": { total: 3, byModel: { "google/gemini": 3 } } }, { requests: 1, inputTokens: 0, outputTokens: 0 }),
    });

    const merged = await mergeAndSaveState(statePath, incoming);

    expect(merged.activeProfile).toBe("zai");
    expect(merged.ledger?.days["2026-11-23"]?.total).toBe(3);
    expect((await readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("saveActiveProfileName preserves the on-disk ledger and stamps the switch", async () => {
    await saveProState(statePath, stateWith({
      ledger: ledgerWith({ "2026-11-19": { total: 5, byModel: { "zai/glm-5.3": 5 } } }, { requests: 1, inputTokens: 0, outputTokens: 0 }),
    }));

    const next = await saveActiveProfileName("zai", statePath, { version: 1, parks: [] });

    expect(next.activeProfile).toBe("zai");
    expect(next.lastSwitchedAt).toBeTruthy();
    expect(next.ledger?.days["2026-11-19"]?.total).toBe(5);
  });
});
