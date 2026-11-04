import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ParkEntry, ProState } from "../domain/types.js";
import { formatError, isMissingFileError } from "./store.js";

/**
 * Pro extension state file (`pi-jev-router-pro-state.json`,
 * constitution §8). This is the only routing-relevant file the extension
 * writes on its own: active profile name, persisted parking, spend ledger.
 */

const EMPTY: ProState = { version: 1, parks: [] };

export async function loadProState(statePath: string): Promise<ProState> {
  try {
    const raw = JSON.parse(await readFile(statePath, "utf8")) as Partial<ProState>;
    return {
      version: 1,
      activeProfile: typeof raw.activeProfile === "string" ? raw.activeProfile : undefined,
      lastSwitchedAt: typeof raw.lastSwitchedAt === "string" ? raw.lastSwitchedAt : undefined,
      parks: sanitizeParks(raw.parks),
      ledger: raw.ledger,
    };
  } catch (error) {
    if (isMissingFileError(error)) return { ...EMPTY };
    throw new Error(`Failed to load pro state at ${statePath}: ${formatError(error)}`);
  }
}

function sanitizeParks(parks: unknown): ParkEntry[] {
  if (!Array.isArray(parks)) return [];
  return parks.filter(
    (park): park is ParkEntry =>
      Boolean(park) && typeof park.key === "string" && park.key.includes("/") && typeof park.until === "number" && Number.isFinite(park.until),
  );
}

export async function saveProState(statePath: string, state: ProState): Promise<void> {
  try {
    await mkdir(dirname(statePath), { recursive: true });
    const content = `${JSON.stringify({ ...state, version: 1 }, null, 2)}\n`;
    await writeFile(statePath, content, "utf8");
  } catch (error) {
    throw new Error(`Failed to save pro state at ${statePath}: ${formatError(error)}`);
  }
}

export async function saveActiveProfileName(activeProfile: string | undefined, statePath: string, previous: ProState): Promise<ProState> {
  const next: ProState = {
    ...previous,
    activeProfile,
    lastSwitchedAt: activeProfile ? new Date().toISOString() : previous.lastSwitchedAt,
  };
  await saveProState(statePath, next);
  return next;
}
