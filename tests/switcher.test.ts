import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProRouterRuntime } from "../src/profiles/switcher.js";
import { loadProState } from "../src/profiles/state.js";
import { detectLegacyRouter } from "../src/storage/paths.js";
import { effectiveConfig } from "../src/jev/config.js";

/**
 * R8.2: switching is memory + pro state only — the legacy router config is
 * never rewritten and no reload is involved. R9.1: legacy import. R5.1:
 * parking persists in the pro state file across sessions.
 */

const PROFILES = {
  google: {
    useDefaultModels: false,
    routes: { quick: [{ provider: "google", model: "gemini-3.5-flash-lite" }], standard: [{ provider: "google", model: "gemini-3.8-flash" }], high: [{ provider: "google", model: "gemini-3.8-flash" }], premium: [{ provider: "google", model: "gemini-3.8-flash" }], xpremium: [] },
  },
  zai: {
    useDefaultModels: false,
    routes: { quick: [{ provider: "zai", model: "glm-5.3-flash" }], standard: [{ provider: "zai", model: "glm-5.3" }], high: [{ provider: "zai", model: "glm-5.3" }], premium: [{ provider: "zai", model: "glm-5.3" }], xpremium: [] },
  },
};

describe("ProRouterRuntime switching (R8.2)", () => {
  let dir: string;
  let profilesPath: string;
  let legacyPath: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "switcher-test-"));
    profilesPath = join(dir, "profiles.json");
    legacyPath = join(dir, "pi-jev-model-router.json");
    statePath = join(dir, "pi-jev-router-pro-state.json");
    await writeFile(profilesPath, JSON.stringify(PROFILES, null, 2), "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function newRuntime(): Promise<ProRouterRuntime> {
    const runtime = new ProRouterRuntime({ profilesPath, legacyRouterConfigPath: legacyPath, statePath });
    await runtime.initialize();
    return runtime;
  }

  it("switches in memory and persists only the active profile name", async () => {
    const runtime = await newRuntime();
    expect(runtime.getActiveProfileName()).toBeUndefined();

    const result = await runtime.switchProfile("zai");
    expect(result.currentProfileName).toBe("zai");
    expect(result.previousProfileName).toBeUndefined();
    expect(result.providers).toEqual(["zai"]);

    // Effective config now routes on zai models — same process, no reload.
    expect(runtime.config.routes.quick[0]).toEqual({ provider: "zai", model: "glm-5.3-flash" });

    // The profiles file is untouched; only the pro state file records the switch.
    expect(JSON.parse(await readFile(profilesPath, "utf8"))).toEqual(PROFILES);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.activeProfile).toBe("zai");
    expect(state.lastSwitchedAt).toBeTruthy();

    // And a fresh runtime (a new session) restores the active profile.
    expect((await newRuntime()).getActiveProfileName()).toBe("zai");
  });

  it("rebuilds routing config on switch: the next request dispatches from the other profile", async () => {
    const runtime = await newRuntime();
    await runtime.switchProfile("google");
    expect(runtime.config.routes.quick[0].provider).toBe("google");
    await runtime.switchProfile("zai");
    expect(runtime.config.routes.quick[0].provider).toBe("zai");
    expect(runtime.config.kindMinimumTier.plan).toBeDefined();
  });

  it("rejects unknown profiles", async () => {
    const runtime = await newRuntime();
    await expect(runtime.switchProfile("nope")).rejects.toThrow(/does not exist/);
  });

  it("clears the active profile on clearActiveProfile", async () => {
    const runtime = await newRuntime();
    await runtime.switchProfile("zai");
    await runtime.clearActiveProfile();
    expect(runtime.getActiveProfileName()).toBeUndefined();
    expect((await loadProState(statePath)).activeProfile).toBeUndefined();
  });
});

describe("legacy import (R9.1)", () => {
  it("imports the legacy config as implicit default when no profiles exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "import-test-"));
    try {
      const profilesPath = join(dir, "profiles.json"); // missing
      const legacyPath = join(dir, "pi-jev-model-router.json");
      const statePath = join(dir, "state.json");
      await writeFile(legacyPath, JSON.stringify(PROFILES.zai), "utf8");

      const runtime = new ProRouterRuntime({ profilesPath, legacyRouterConfigPath: legacyPath, statePath });
      await runtime.initialize();
      expect(runtime.getActiveProfileName()).toBe("default");
      expect(runtime.config.routes.quick[0]).toEqual({ provider: "zai", model: "glm-5.3-flash" });
      // Read-only: the legacy file is untouched.
      expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual(PROFILES.zai);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prefers an exact legacy-config match over the implicit default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "import-test-"));
    try {
      const profilesPath = join(dir, "profiles.json");
      const legacyPath = join(dir, "pi-jev-model-router.json");
      const statePath = join(dir, "state.json");
      await writeFile(profilesPath, JSON.stringify(PROFILES, null, 2), "utf8");
      await writeFile(legacyPath, JSON.stringify({ useDefaultModels: false, routes: PROFILES.google.routes }), "utf8");

      const runtime = new ProRouterRuntime({ profilesPath, legacyRouterConfigPath: legacyPath, statePath });
      await runtime.initialize();
      expect(runtime.getActiveProfileName()).toBe("google");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parking persistence across sessions (R5.1)", () => {
  it("keeps parks in the pro state file until expiry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "park-state-test-"));
    try {
      const statePath = join(dir, "state.json");
      const runtime = new ProRouterRuntime({ profilesPath: join(dir, "missing-profiles.json"), legacyRouterConfigPath: join(dir, "legacy.json"), statePath });
      await runtime.initialize();
      runtime.parking.park("zai/glm-5.3", 3600_000, Date.now());
      await runtime.persistState();

      const onDisk = await loadProState(statePath);
      expect(onDisk.parks).toHaveLength(1);
      expect(onDisk.parks[0].key).toBe("zai/glm-5.3");

      const nextSession = new ProRouterRuntime({ profilesPath: join(dir, "missing-profiles.json"), legacyRouterConfigPath: join(dir, "legacy.json"), statePath });
      await nextSession.initialize();
      expect(nextSession.parking.has("zai/glm-5.3")).toBe(true);
      expect(nextSession.parking.list().join(" ")).toMatch(/parked until/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("env knobs (R9.2, R9.3)", () => {
  it("resolves JEV_ROUTER_MODE and JEV_ROUTER_OFF", () => {
    const on = effectiveConfig(PROFILES.zai, { JEV_ROUTER_MODE: "notify" });
    expect(on.mode).toBe("notify");
    expect(on.enabled).toBe(true);
    const off = effectiveConfig(PROFILES.zai, { JEV_ROUTER_OFF: "1" });
    expect(off.enabled).toBe(false);
    const invalid = effectiveConfig(PROFILES.zai, { JEV_ROUTER_MODE: "bogus" });
    expect(invalid.mode).toBe("auto");
  });

  it("detects installed legacy routers from pi settings (R9.3)", () => {
    expect(detectLegacyRouter({ packages: ["npm:pi-jev-model-router", "npm:pi-jev-model-router-profile-switcher", "npm:pi-scroll"] })).toEqual([
      "pi-jev-model-router",
      "pi-jev-model-router-profile-switcher",
    ]);
    expect(detectLegacyRouter({ packages: ["npm:pi-scroll"] })).toEqual([]);
    expect(detectLegacyRouter({})).toEqual([]);
  });
});
