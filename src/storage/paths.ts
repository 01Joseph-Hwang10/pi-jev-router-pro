import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Storage paths (design §1 `storage/paths.ts`). The pro extension writes only
 * its own files (constitution §8); the legacy profiles file is read, and
 * written solely by explicit profile-CRUD commands, since it is the
 * operator's own data file.
 */

const CONFIG_DIR = ".pi";
const AGENT_DIR = "agent";

export const PROFILES_FILE_NAME = "pi-jev-model-router-profiles.json";
export const LEGACY_ROUTER_CONFIG_FILE_NAME = "pi-jev-model-router.json";
export const LEGACY_SWITCHER_STATE_FILE_NAME = "pi-jev-model-router-profile-switcher-state.json";
export const PRO_CONFIG_FILE_NAME = "pi-jev-router-pro.json";
export const PRO_STATE_FILE_NAME = "pi-jev-router-pro-state.json";
export const PRO_QUOTA_FILE_NAME = "pi-jev-router-pro-quota.json";
export const PI_SETTINGS_FILE_NAME = "settings.json";

export function agentDir(): string {
  return process.env.JEV_ROUTER_AGENT_DIR?.trim() || join(homedir(), CONFIG_DIR, AGENT_DIR);
}

export function profilesPath(override?: string): string {
  return (
    override?.trim() ||
    process.env.JEV_ROUTER_PROFILES?.trim() ||
    join(process.env.JEV_ROUTER_AGENT_DIR?.trim() || join(homedir(), CONFIG_DIR, AGENT_DIR), PROFILES_FILE_NAME)
  );
}

export function legacyRouterConfigPath(): string {
  return process.env.JEV_ROUTER_LEGACY_CONFIG?.trim() || join(agentDir(), LEGACY_ROUTER_CONFIG_FILE_NAME);
}

export function legacySwitcherStatePath(): string {
  return process.env.JEV_ROUTER_LEGACY_SWITCHER_STATE?.trim() || join(agentDir(), LEGACY_SWITCHER_STATE_FILE_NAME);
}

export function proConfigPath(): string {
  return process.env.JEV_ROUTER_PRO_CONFIG?.trim() || join(agentDir(), PRO_CONFIG_FILE_NAME);
}

export function proStatePath(): string {
  return process.env.JEV_ROUTER_PRO_STATE?.trim() || join(agentDir(), PRO_STATE_FILE_NAME);
}

export function proQuotaPath(): string {
  return process.env.JEV_ROUTER_PRO_QUOTA?.trim() || join(agentDir(), PRO_QUOTA_FILE_NAME);
}

export function piSettingsPath(): string {
  return process.env.JEV_ROUTER_PI_SETTINGS?.trim() || join(agentDir(), PI_SETTINGS_FILE_NAME);
}

export function accountSwitcherAccountsPath(): string {
  return join(homedir(), CONFIG_DIR, "account-switcher", "accounts.json");
}

export function accountSwitcherStatePath(): string {
  return join(homedir(), CONFIG_DIR, "account-switcher", "state.json");
}

function readJsonSync(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export { readJsonSync };

/**
 * R9.3: detect a simultaneously installed legacy router (read-only settings
 * scan) so session start can warn once about duplicate routing surfaces.
 */
export function detectLegacyRouter(settings: unknown): string[] {
  const packages = (settings as { packages?: unknown })?.packages;
  if (!Array.isArray(packages)) return [];
  const legacy: string[] = [];
  for (const entry of packages) {
    if (typeof entry !== "string") continue;
    if (/(^|[:/])pi-jev-model-router$/.test(entry)) legacy.push("pi-jev-model-router");
    if (/(^|[:/])pi-jev-model-router-profile-switcher$/.test(entry)) legacy.push("pi-jev-model-router-profile-switcher");
  }
  return [...new Set(legacy)];
}

export function readLegacyRouterNames(settingsPath = piSettingsPath()): string[] {
  return detectLegacyRouter(readJsonSync(settingsPath));
}
