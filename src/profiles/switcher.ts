import { readFile } from "node:fs/promises";
import type { JevProfile, JevRouterConfig, LedgerData, ProfilesCollection, ProConfig, ProState } from "../domain/types.js";
import { effectiveConfig } from "../jev/config.js";
import { Parking } from "../routing/parking.js";
import { emptyLedger, loadLedger } from "../routing/budget.js";
import {
  findMatchingProfile,
  implicitProfileFromLegacyConfig,
  loadProfiles,
  saveProfiles,
  type ProfileSummary,
  getProfileSummary,
  extractProvidersFromProfile,
} from "./store.js";
import { loadProState, saveActiveProfileName, saveProState } from "./state.js";

/**
 * The pro router runtime's data plane (design §1 `profiles/switcher.ts`).
 * Profiles are data; switching is memory: a profile swap updates the
 * in-memory collection and persists only the active profile name to the pro
 * state file (constitution §8). It never rewrites the legacy router config
 * and never requires a reload to take effect (R8.2).
 */

export interface SwitchResult {
  previousProfileName?: string;
  currentProfileName: string;
  providers: string[];
}

export interface ProRouterRuntimeOptions {
  profilesPath: string;
  legacyRouterConfigPath: string;
  statePath: string;
}

export class ProRouterRuntime {
  private profiles: ProfilesCollection = {};
  private implicit: ProfilesCollection = {};
  private activeProfileName: string | undefined;

  readonly state: ProState = { version: 1, parks: [] };
  parking: Parking;
  ledger: LedgerData = emptyLedger();
  /** Effective routing config for the active profile; rebuilt on switch/reload. */
  config: JevRouterConfig;

  constructor(
    private readonly options: ProRouterRuntimeOptions,
    readonly proConfig: ProConfig = {},
  ) {
    this.parking = new Parking(
      () => this.state.parks,
      (entries) => {
        this.state.parks = entries;
        void this.persistState();
        return true;
      },
    );
    this.config = effectiveConfig(undefined);
  }

  get profilesPath(): string {
    return this.options.profilesPath;
  }

  get statePath(): string {
    return this.options.statePath;
  }

  getActiveProfileName(): string | undefined {
    return this.activeProfileName;
  }

  getActiveProfile(): JevProfile | undefined {
    if (!this.activeProfileName) return undefined;
    return this.allProfiles()[this.activeProfileName];
  }

  getProfile(profileName: string): JevProfile | undefined {
    return this.allProfiles()[profileName];
  }

  getAllProfiles(): ProfilesCollection {
    return { ...this.allProfiles() };
  }

  getProfileNames(): string[] {
    return Object.keys(this.allProfiles());
  }

  getProfileSummaries(): ProfileSummary[] {
    const profiles = this.allProfiles();
    return Object.entries(profiles).map(([name, profile]) => getProfileSummary(name, profile, name === this.activeProfileName));
  }

  private allProfiles(): ProfilesCollection {
    return { ...this.profiles, ...this.implicit };
  }

  /**
   * Rebuild the effective routing config from the active profile (R8.2:
   * takes effect on the next request, no reload).
   */
  private rebuildConfig(): void {
    const profile = this.getActiveProfile();
    this.config = effectiveConfig(profile ? patchOf(profile) : undefined);
  }

  /**
   * Load everything from disk: profiles, pro state (active profile, parking,
   * ledger), the legacy config import, and detect the active profile.
   */
  async initialize(): Promise<void> {
    const [profiles, state, legacyConfig] = await Promise.all([
      loadProfiles(this.options.profilesPath),
      loadProState(this.options.statePath),
      readJsonFile(this.options.legacyRouterConfigPath),
    ]);
    this.profiles = profiles;
    Object.assign(this.state, state);
    this.ledger = loadLedger(state.ledger);
    this.parking = new Parking(
      () => this.state.parks,
      (entries) => {
        this.state.parks = entries;
        void this.persistState();
        return true;
      },
      state.parks,
    );

    // R9.1: legacy router config as an implicit `default` profile on first run.
    if (legacyConfig && Object.keys(this.profiles).length === 0 && this.proConfig.detectLegacyProfile !== false) {
      this.implicit = { default: implicitProfileFromLegacyConfig(legacyConfig) };
    }

    this.activeProfileName = this.detectActiveProfile(legacyConfig);
    this.rebuildConfig();
  }

  private detectActiveProfile(legacyConfig: Record<string, unknown> | undefined): string | undefined {
    // Detached mode (pro config): no legacy-based detection at all.
    if (this.proConfig.detectLegacyProfile === false) {
      return this.state.activeProfile && this.state.activeProfile in this.allProfiles() ? this.state.activeProfile : undefined;
    }
    // 1. The pro state file wins.
    if (this.state.activeProfile && this.state.activeProfile in this.allProfiles()) {
      return this.state.activeProfile;
    }
    // 2. Legacy switcher state, so a mid-migration setup keeps its profile.
    //    (Deferred: parsed opportunistically; the pro state file is authoritative.)
    // 3. Exact match of the legacy router config against a known profile.
    const matched = findMatchingProfile(legacyConfig, this.allProfiles());
    if (matched) return matched;
    // 4. The implicit default profile, when the legacy config exists.
    if (legacyConfig && "default" in this.implicit) return "default";
    return undefined;
  }

  async persistState(): Promise<void> {
    try {
      await saveProState(this.options.statePath, { ...this.state, ledger: this.ledger });
    } catch {
      // Best-effort: routing must never break because state could not be saved.
    }
  }

  /**
   * Swap the routing config in memory and persist only the active profile
   * name (R8.2). No legacy config rewrite, no reload.
   */
  async switchProfile(profileName: string): Promise<SwitchResult> {
    const normalizedName = profileName.trim();
    const targetProfile = this.allProfiles()[normalizedName];
    if (!targetProfile) {
      throw new Error(`Profile "${normalizedName}" does not exist. Available profiles: ${this.getProfileNames().join(", ")}`);
    }
    const previousProfileName = this.activeProfileName;
    this.activeProfileName = normalizedName;
    this.rebuildConfig();
    const next = await saveActiveProfileName(normalizedName, this.options.statePath, this.state);
    Object.assign(this.state, next);
    return {
      previousProfileName,
      currentProfileName: normalizedName,
      providers: extractProvidersFromProfile(targetProfile),
    };
  }

  async clearActiveProfile(): Promise<void> {
    this.activeProfileName = undefined;
    this.rebuildConfig();
    const next = await saveActiveProfileName(undefined, this.options.statePath, this.state);
    Object.assign(this.state, next);
  }

  async reloadProfiles(): Promise<void> {
    this.profiles = await loadProfiles(this.options.profilesPath);
    if (this.activeProfileName && !(this.activeProfileName in this.allProfiles())) {
      this.activeProfileName = undefined;
    }
    this.rebuildConfig();
  }

  /** Capture the active profile's routing config as a new named profile. */
  async saveSnapshotAsProfile(profilesCollection: ProfilesCollection, name: string, profile: JevProfile): Promise<void> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("Profile name cannot be empty.");
    profilesCollection[normalizedName] = profile;
    await saveProfiles(profilesCollection, this.options.profilesPath);
    this.profiles = profilesCollection;
    delete this.implicit[normalizedName];
    this.activeProfileName = normalizedName;
    this.rebuildConfig();
    const next = await saveActiveProfileName(normalizedName, this.options.statePath, this.state);
    Object.assign(this.state, next);
  }

  getSnapshotForSave(): JevProfile | undefined {
    return this.getActiveProfile();
  }
}

function patchOf(profile: JevProfile): Record<string, unknown> {
  // `effectiveConfig` handles the full profile patch; `name`/`description`/
  // `recommendedAccounts` are ignored inside `merge` via the spread of
  // unknown keys onto the config (harmless), so pass the profile as-is.
  return profile as Record<string, unknown>;
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
