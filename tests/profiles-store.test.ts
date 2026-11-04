import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneProfile,
  createProfile,
  deleteProfile,
  ensureExampleProfiles,
  extractProvidersFromProfile,
  findMatchingProfile,
  formatProfileListItem,
  getProfileSummary,
  implicitProfileFromLegacyConfig,
  loadProfiles,
  renameProfile,
  saveProfiles,
  updateProfile,
} from "../src/profiles/store.js";
import { profileToRouterConfig } from "../src/jev/config.js";
import type { JevProfile, ProfilesCollection } from "../src/domain/types.js";

/**
 * R8.1: profile round-trip against the operator's real profiles-file shape
 * (keys `google` / `zai`, `useDefaultModels: false`, routes + kindModels with
 * minTier). R9.1: legacy config import.
 */

/** Fixture copied from the operator's actual pi-jev-model-router-profiles.json shape. */
const OPERATOR_PROFILES: ProfilesCollection = {
  google: {
    useDefaultModels: false,
    routes: {
      quick: [{ provider: "google", model: "gemini-3.5-flash-lite" }],
      standard: [{ provider: "google", model: "gemini-3.8-flash" }],
      high: [{ provider: "google", model: "gemini-4-argon" }],
      premium: [{ provider: "google", model: "gemini-4-argon" }],
    },
    kindModels: {
      plan: [{ provider: "google", model: "gemini-4-argon", minTier: "high" }],
      implement: [{ provider: "google", model: "gemini-3.8-flash", minTier: "standard" }],
      explain: [{ provider: "google", model: "gemini-3.5-flash-lite", minTier: "quick" }],
    },
  },
  "zai-coding-cn": {
    useDefaultModels: false,
    routes: {
      quick: [
        { provider: "zai-coding-cn", model: "glm-5.3-flash" },
        { provider: "zai", model: "glm-5.3-flash" },
      ],
      standard: [
        { provider: "zai-coding-cn", model: "glm-5.3-flash" },
        { provider: "zai", model: "glm-5.3-flash" },
      ],
      high: [
        { provider: "zai-coding-cn", model: "glm-5.3-flash" },
        { provider: "zai", model: "glm-5.3-flash" },
      ],
      premium: [
        { provider: "zai-coding-cn", model: "glm-5.3" },
        { provider: "zai", model: "glm-5.3" },
      ],
    },
    kindModels: {
      plan: [
        { provider: "zai-coding-cn", model: "glm-5.3", minTier: "premium" },
        { provider: "zai", model: "glm-5.3", minTier: "premium" },
      ],
      implement: [{ provider: "zai-coding-cn", model: "glm-5.3-flash", minTier: "standard" }],
    },
  },
};

describe("profiles store round-trip (R8.1)", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "profiles-test-"));
    file = join(dir, "pi-jev-model-router-profiles.json");
    await writeFile(file, JSON.stringify(OPERATOR_PROFILES, null, 2), "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips the operator's real file structure unchanged", async () => {
    const loaded = await loadProfiles(file);
    expect(Object.keys(loaded).sort()).toEqual(["google", "zai-coding-cn"]);
    expect(loaded.google?.routes?.premium?.[0]).toEqual({ provider: "google", model: "gemini-4-argon" });
    expect(loaded["zai-coding-cn"]?.kindModels?.plan?.[1]?.minTier).toBe("premium");

    // A full save → load cycle preserves every field byte-for-value.
    await saveProfiles(loaded, file);
    const again = JSON.parse(await readFile(file, "utf8")) as ProfilesCollection;
    expect(again).toEqual(OPERATOR_PROFILES);
  });

  it("summarizes profiles for listing (R8.5 badges)", () => {
    const loaded = loadProfilesSync(file);
    const summary = getProfileSummary("google", loaded.google!, false);
    expect(summary.providers).toEqual(["google"]);
    expect(summary.routesSummary.quick).toBe("google/gemini-3.5-flash-lite");
    expect(summary.kindModelCount).toBe(3);
    expect(summary.useDefaultModels).toBe(false);
    expect(formatProfileListItem("google", loaded.google!, true)).toMatch(/● \[ACTIVE\] google \[google\]/);
    expect(extractProvidersFromProfile(loaded["zai-coding-cn"]!).sort()).toEqual(["zai", "zai-coding-cn"]);
  });

  it("supports CRUD: create, update, clone, rename, delete", async () => {
    await createProfile("new", { useDefaultModels: false, routes: { quick: [{ provider: "p", model: "m" }] } }, file);
    await expect(createProfile("new", {}, file)).rejects.toThrow(/already exists/);

    await updateProfile("new", { useDefaultModels: true }, file);
    expect((await loadProfiles(file)).new?.useDefaultModels).toBe(true);
    await expect(updateProfile("ghost", {}, file)).rejects.toThrow(/does not exist/);

    await cloneProfile("google", "google-copy", file);
    expect((await loadProfiles(file))["google-copy"]?.routes?.quick?.[0]?.provider).toBe("google");
    await expect(cloneProfile("google", "google-copy", file)).rejects.toThrow(/already exists/);

    await renameProfile("google-copy", "renamed", file);
    const afterRename = await loadProfiles(file);
    expect(afterRename.renamed).toBeDefined();
    expect(afterRename["google-copy"]).toBeUndefined();

    await deleteProfile("renamed", file);
    expect((await loadProfiles(file)).renamed).toBeUndefined();
    await expect(deleteProfile("renamed", file)).rejects.toThrow(/does not exist/);
  });

  it("writes starter examples only when the file is missing", async () => {
    const missing = join(dir, "fresh-profiles.json");
    expect(await ensureExampleProfiles(missing)).toBe(true);
    expect(Object.keys(await loadProfiles(missing))).toEqual(["google", "zai"]);
    expect(await ensureExampleProfiles(missing)).toBe(false);
  });
});

import { readFileSync } from "node:fs";
function loadProfilesSync(file: string): ProfilesCollection {
  return JSON.parse(readFileSync(file, "utf8")) as ProfilesCollection;
}

describe("legacy import + matching (R9.1, R8.2 detection)", () => {
  it("imports the legacy router config as an implicit default profile", () => {
    const legacyConfig = {
      useDefaultModels: false,
      routes: OPERATOR_PROFILES["zai-coding-cn"]!.routes,
      kindModels: OPERATOR_PROFILES["zai-coding-cn"]!.kindModels,
    };
    const profile = implicitProfileFromLegacyConfig(legacyConfig);
    expect(profile.description).toMatch(/read-only until saved/);
    expect(profile.routes).toEqual(OPERATOR_PROFILES["zai-coding-cn"]!.routes);

    // The implicit profile maps back to the same router config.
    const roundTrip = profileToRouterConfig(profile);
    expect(roundTrip.routes).toEqual(legacyConfig.routes);
    expect(roundTrip.kindModels).toEqual(legacyConfig.kindModels);
    expect(roundTrip.description).toBeUndefined();
    expect(roundTrip.name).toBeUndefined();
  });

  it("detects which profile the legacy config matches exactly", () => {
    const profiles: ProfilesCollection = {
      google: OPERATOR_PROFILES.google!,
      zai: OPERATOR_PROFILES["zai-coding-cn"]!,
    };
    const activeConfig = profileToRouterConfig(OPERATOR_PROFILES.google!);
    expect(findMatchingProfile(activeConfig, profiles)).toBe("google");
    expect(findMatchingProfile({ useDefaultModels: true, routes: { quick: [] } }, profiles)).toBeUndefined();
    expect(findMatchingProfile(undefined, profiles)).toBeUndefined();
  });

  it("strips profile metadata from the router config", () => {
    const profile: JevProfile = {
      name: "test",
      description: "A test profile",
      recommendedAccounts: { google: "work" },
      useDefaultModels: false,
      routes: { quick: [{ provider: "google", model: "gemini-3.5-flash-lite" }] },
    };
    const routerConfig = profileToRouterConfig(profile);
    expect(routerConfig.description).toBeUndefined();
    expect(routerConfig.recommendedAccounts).toBeUndefined();
    expect(routerConfig.useDefaultModels).toBe(false);
    expect(routerConfig.routes).toEqual(profile.routes);
  });
});
