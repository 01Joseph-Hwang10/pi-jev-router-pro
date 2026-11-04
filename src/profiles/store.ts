import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JevProfile, ProfilesCollection, Tier, RouteChain, RouteTarget } from "../domain/types.js";
import { TIERS } from "../domain/types.js";
import { profileToRouterConfig } from "../jev/config.js";

/**
 * Profiles-file IO and formatting. Ported from the legacy profile-switcher's
 * `storage/profiles.ts` + `shared/format.ts`. The file is the operator's own
 * data (`pi-jev-model-router-profiles.json`, constitution §8): CRUD commands
 * may write it; routing never does.
 */

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT";
}

export async function loadProfiles(filePath: string): Promise<ProfilesCollection> {
  try {
    const rawContent = await readFile(filePath, "utf8");
    const parsed = JSON.parse(rawContent);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Profiles file content must be a JSON object mapping names to profiles.");
    }
    return parsed as ProfilesCollection;
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }
    throw new Error(`Failed to load Jev router profiles from ${filePath}: ${formatError(error)}`);
  }
}

export async function saveProfiles(profiles: ProfilesCollection, filePath: string): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const content = `${JSON.stringify(profiles, null, 2)}\n`;
    await writeFile(filePath, content, "utf8");
  } catch (error) {
    throw new Error(`Failed to save Jev router profiles to ${filePath}: ${formatError(error)}`);
  }
}

export async function createProfile(profileName: string, profile: JevProfile, filePath: string): Promise<void> {
  const normalizedName = profileName.trim();
  if (!normalizedName) {
    throw new Error("Profile name cannot be empty.");
  }
  const profiles = await loadProfiles(filePath);
  if (normalizedName in profiles) {
    throw new Error(`Profile "${normalizedName}" already exists.`);
  }
  profiles[normalizedName] = profile;
  await saveProfiles(profiles, filePath);
}

export async function updateProfile(profileName: string, profile: JevProfile, filePath: string): Promise<void> {
  const normalizedName = profileName.trim();
  const profiles = await loadProfiles(filePath);
  if (!(normalizedName in profiles)) {
    throw new Error(`Profile "${normalizedName}" does not exist.`);
  }
  profiles[normalizedName] = profile;
  await saveProfiles(profiles, filePath);
}

export async function deleteProfile(profileName: string, filePath: string): Promise<void> {
  const normalizedName = profileName.trim();
  const profiles = await loadProfiles(filePath);
  if (!(normalizedName in profiles)) {
    throw new Error(`Profile "${normalizedName}" does not exist.`);
  }
  delete profiles[normalizedName];
  await saveProfiles(profiles, filePath);
}

export async function cloneProfile(sourceProfileName: string, targetProfileName: string, filePath: string): Promise<void> {
  const normalizedSource = sourceProfileName.trim();
  const normalizedTarget = targetProfileName.trim();
  if (!normalizedTarget) {
    throw new Error("Target profile name cannot be empty.");
  }
  const profiles = await loadProfiles(filePath);
  if (!(normalizedSource in profiles)) {
    throw new Error(`Source profile "${normalizedSource}" does not exist.`);
  }
  if (normalizedTarget in profiles) {
    throw new Error(`Target profile "${normalizedTarget}" already exists.`);
  }
  profiles[normalizedTarget] = structuredClone(profiles[normalizedSource]);
  await saveProfiles(profiles, filePath);
}

export async function renameProfile(oldProfileName: string, newProfileName: string, filePath: string): Promise<void> {
  const normalizedOld = oldProfileName.trim();
  const normalizedNew = newProfileName.trim();
  if (!normalizedNew) {
    throw new Error("New profile name cannot be empty.");
  }
  if (normalizedOld === normalizedNew) {
    return;
  }
  const profiles = await loadProfiles(filePath);
  if (!(normalizedOld in profiles)) {
    throw new Error(`Profile "${normalizedOld}" does not exist.`);
  }
  if (normalizedNew in profiles) {
    throw new Error(`A profile with name "${normalizedNew}" already exists.`);
  }
  profiles[normalizedNew] = profiles[normalizedOld];
  delete profiles[normalizedOld];
  await saveProfiles(profiles, filePath);
}

/** Minimal starter profiles, written only when the file is missing entirely. */
export async function ensureExampleProfiles(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return false; // Already exists.
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const exampleProfiles: ProfilesCollection = {
    google: {
      description: "Direct Google Gemini models for fast, cost-efficient routing",
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
        debug: [{ provider: "google", model: "gemini-3.8-flash", minTier: "standard" }],
        review: [{ provider: "google", model: "gemini-4-argon", minTier: "high" }],
        explain: [{ provider: "google", model: "gemini-3.5-flash-lite", minTier: "quick" }],
        chat: [{ provider: "google", model: "gemini-3.5-flash-lite", minTier: "quick" }],
      },
    },
    zai: {
      description: "Z.ai GLM models for specialized reasoning and code generation",
      useDefaultModels: false,
      routes: {
        quick: [{ provider: "zai", model: "glm-5.3-flash" }],
        standard: [{ provider: "zai", model: "glm-5.3" }],
        high: [{ provider: "zai", model: "glm-5.3" }],
        premium: [{ provider: "zai", model: "glm-5.3" }],
      },
      kindModels: {
        plan: [{ provider: "zai", model: "glm-5.3", minTier: "high" }],
        implement: [{ provider: "zai", model: "glm-5.3", minTier: "standard" }],
        debug: [{ provider: "zai", model: "glm-5.3", minTier: "standard" }],
        review: [{ provider: "zai", model: "glm-5.3", minTier: "high" }],
        explain: [{ provider: "zai", model: "glm-5.3-flash", minTier: "quick" }],
        chat: [{ provider: "zai", model: "glm-5.3-flash", minTier: "quick" }],
      },
    },
  };

  await saveProfiles(exampleProfiles, filePath);
  return true;
}

// ---------------------------------------------------------------------------
// Formatting helpers (legacy `shared/format.ts` port).
// ---------------------------------------------------------------------------

export interface ProfileSummary {
  name: string;
  isActive: boolean;
  description?: string;
  useDefaultModels: boolean;
  providers: string[];
  routesSummary: Partial<Record<Tier, string>>;
  kindModelCount: number;
}

export function extractProvidersFromProfile(profile: JevProfile): string[] {
  const providerSet = new Set<string>();
  const add = (chain: unknown) => {
    if (!Array.isArray(chain)) return;
    for (const target of chain as RouteTarget[]) {
      if (target && typeof target.provider === "string" && target.provider.trim()) providerSet.add(target.provider.trim());
    }
  };
  if (profile.routes) for (const chain of Object.values(profile.routes)) add(chain);
  if (profile.kindModels) for (const chain of Object.values(profile.kindModels)) add(chain);
  if (profile.free?.pool) add(profile.free.pool);
  return Array.from(providerSet);
}

export function summarizeProfileRoutes(profile: JevProfile): Partial<Record<Tier, string>> {
  const summary: Partial<Record<Tier, string>> = {};
  if (!profile.routes) return summary;
  for (const tier of TIERS) {
    const chain = profile.routes[tier];
    if (chain && chain.length > 0) {
      const firstTarget = chain[0];
      const modelIdentifier = `${firstTarget.provider}/${firstTarget.model}`;
      const additionalCount = chain.length - 1;
      summary[tier] =
        additionalCount > 0 ? `${modelIdentifier} (+${additionalCount} fallback${additionalCount > 1 ? "s" : ""})` : modelIdentifier;
    }
  }
  return summary;
}

export function getProfileSummary(profileName: string, profile: JevProfile, isActive: boolean): ProfileSummary {
  return {
    name: profileName,
    isActive,
    description: profile.description,
    useDefaultModels: profile.useDefaultModels ?? true,
    providers: extractProvidersFromProfile(profile),
    routesSummary: summarizeProfileRoutes(profile),
    kindModelCount: profile.kindModels ? Object.keys(profile.kindModels).length : 0,
  };
}

export function formatRouteChain(chain: RouteChain): string {
  return chain
    .map((target: RouteTarget) => {
      const thinkingPart = target.thinkingLevel ? ` [thinking: ${target.thinkingLevel}]` : "";
      const minTierPart = target.minTier ? ` (minTier: ${target.minTier})` : "";
      return `${target.provider}/${target.model}${thinkingPart}${minTierPart}`;
    })
    .join(" → ");
}

export function formatProfileListItem(profileName: string, profile: JevProfile, isActive: boolean): string {
  const marker = isActive ? "● [ACTIVE]" : "○";
  const providers = extractProvidersFromProfile(profile);
  const providerLabel = providers.length > 0 ? `[${providers.join(", ")}]` : "[no providers]";
  const descriptionPart = profile.description ? ` — ${profile.description}` : "";
  return `${marker} ${profileName} ${providerLabel}${descriptionPart}`;
}

export interface ProviderAccountStatus {
  configuredAccounts: { id: string; label: string; provider: string }[];
  activeAccountId?: string;
  activeAccountLabel?: string;
}

export function formatProfileDetailView(
  profileName: string,
  profile: JevProfile,
  isActive: boolean,
  accountStatuses?: Record<string, ProviderAccountStatus>,
): string {
  const providers = extractProvidersFromProfile(profile);
  const lines = [`${isActive ? "● [ACTIVE] " : "○ "}${profileName} [${providers.join(", ")}]`];
  if (profile.description) {
    lines.push(`Description: ${profile.description}`);
  }
  lines.push(`Built-in models: ${profile.useDefaultModels === false ? "off (config-only)" : "on"}`);

  if (accountStatuses && Object.keys(accountStatuses).length > 0) {
    lines.push("", "Account Switcher Status:");
    for (const [provider, status] of Object.entries(accountStatuses)) {
      if (status.configuredAccounts.length === 0) {
        lines.push(`  ${provider}: No accounts configured in pi-account-switcher`);
      } else {
        const activeLabel = status.activeAccountLabel ? `✓ Active: ${status.activeAccountLabel}` : "⚠️ None active";
        lines.push(`  ${provider}: ${status.configuredAccounts.length} account(s) available (${activeLabel})`);
      }
    }
  }

  lines.push("", "Tier Routes:");
  if (profile.routes) {
    for (const tier of TIERS) {
      const chain = profile.routes[tier];
      if (chain && chain.length > 0) {
        lines.push(`  ${tier.padEnd(9)}: ${formatRouteChain(chain)}`);
      } else {
        lines.push(`  ${tier.padEnd(9)}: (empty)`);
      }
    }
  } else {
    lines.push("  (no explicit tier routes configured)");
  }

  if (profile.kindModels && Object.keys(profile.kindModels).length > 0) {
    lines.push(`\nKind Specialists (${Object.keys(profile.kindModels).length}):`);
    for (const [kind, chain] of Object.entries(profile.kindModels)) {
      lines.push(`  ${kind.padEnd(10)}: ${formatRouteChain(chain)}`);
    }
  }

  if (profile.free?.enabled && profile.free.pool && profile.free.pool.length > 0) {
    lines.push(`\nFree Pool (${profile.free.policy}):`);
    lines.push(`  ${formatRouteChain(profile.free.pool)}`);
  }

  if (profile.budget) {
    const budgetParts: string[] = [];
    if (typeof profile.budget.dailyUsd === "number") budgetParts.push(`daily: $${profile.budget.dailyUsd}`);
    if (typeof profile.budget.monthlyUsd === "number") budgetParts.push(`monthly: $${profile.budget.monthlyUsd}`);
    if (budgetParts.length > 0) lines.push(`\nBudget: ${budgetParts.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * R9.1: legacy `pi-jev-model-router.json` importable as an implicit `default`
 * profile. Read-only: the implicit profile lives in memory until an explicit
 * save command persists it into the profiles file.
 */
export function implicitProfileFromLegacyConfig(config: Record<string, unknown>, description?: string): JevProfile {
  return {
    ...(description ? { description } : { description: "Imported from pi-jev-model-router.json (read-only until saved)" }),
    ...structuredClone(config),
  };
}

/** Exact-match detection of which profile a legacy router config represents. */
export function findMatchingProfile(activeConfiguration: Record<string, unknown> | undefined, profiles: ProfilesCollection): string | undefined {
  if (!activeConfiguration) return undefined;
  for (const [profileName, profile] of Object.entries(profiles)) {
    const candidateConfig = profileToRouterConfig(profile);
    if (isConfigurationSubsetEqual(candidateConfig, activeConfiguration)) {
      return profileName;
    }
  }
  return undefined;
}

function isConfigurationSubsetEqual(candidate: Record<string, unknown>, active: Record<string, unknown>): boolean {
  if ("routes" in candidate && JSON.stringify(candidate.routes) !== JSON.stringify(active.routes)) return false;
  if ("kindModels" in candidate && JSON.stringify(candidate.kindModels) !== JSON.stringify(active.kindModels)) return false;
  if (typeof candidate.useDefaultModels === "boolean" && candidate.useDefaultModels !== active.useDefaultModels) return false;
  return true;
}
