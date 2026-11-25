import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import type { LedgerData, ParkEntry, ProState } from "../domain/types.js";
import { round4 } from "../routing/budget.js";
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
    const state = sanitizeProState(raw);
    try {
      return await reconcileSyncConflictCopies(statePath, state);
    } catch {
      return state; // Conflict healing is best-effort; never fail the load.
    }
  } catch (error) {
    if (isMissingFileError(error)) return { ...EMPTY };
    throw new Error(`Failed to load pro state at ${statePath}: ${formatError(error)}`);
  }
}

function sanitizeProState(raw: Partial<ProState>): ProState {
  return {
    version: 1,
    activeProfile: typeof raw.activeProfile === "string" ? raw.activeProfile : undefined,
    lastSwitchedAt: typeof raw.lastSwitchedAt === "string" ? raw.lastSwitchedAt : undefined,
    parks: sanitizeParks(raw.parks),
    ledger: raw.ledger,
  };
}

function sanitizeParks(parks: unknown): ParkEntry[] {
  if (!Array.isArray(parks)) return [];
  return parks.filter(
    (park): park is ParkEntry =>
      Boolean(park) && typeof park.key === "string" && park.key.includes("/") && typeof park.until === "number" && Number.isFinite(park.until),
  );
}

export async function saveProState(statePath: string, state: ProState): Promise<void> {
  // Atomic temp+rename (same pattern as fileParking): a concurrent merge-read
  // never observes a half-written file — merge-before-write depends on it.
  const temp = `${statePath}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(statePath), { recursive: true });
    const content = `${JSON.stringify({ ...state, version: 1 }, null, 2)}\n`;
    await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await rename(temp, statePath);
  } catch (error) {
    throw new Error(`Failed to save pro state at ${statePath}: ${formatError(error)}`);
  } finally {
    try {
      await rm(temp, { force: true });
    } catch {
      /* Best-effort cleanup. */
    }
  }
}

/** Marker Syncthing (and similar sync tools) insert into losing copies of a file. */
const SYNC_CONFLICT_MARKER = ".sync-conflict-";

/**
 * Self-heal Syncthing conflict copies of the state file. When two devices write
 * the state file while offline from each other, the sync tool keeps the winner
 * and leaves a losing copy like
 * `pi-jev-router-pro-state.sync-conflict-20261119-200429-B6UWKUB.json` behind.
 * The spend ledger is additive across devices, so a losing copy can hold spend
 * the winning copy never saw. Merge every readable copy into the loaded
 * state, persist the merge, and delete the copies (constitution §8:
 * only our own state files are touched). Counters merge by max — conservative,
 * never over-reports spend to the budget caps. Best-effort: failures keep the
 * copies in place for the next load and never break routing.
 */
export async function reconcileSyncConflictCopies(statePath: string, state: ProState): Promise<ProState> {
  const dir = dirname(statePath);
  const fileName = basename(statePath);
  // Syncthing inserts the marker into the file stem and keeps the extension:
  // `pi-jev-router-pro-state.json` loses a race as
  // `pi-jev-router-pro-state.sync-conflict-20261119-200429-B6UWKUB.json`.
  // Also accept the suffix-after-full-name variant for other sync tools.
  const stem = fileName.slice(0, fileName.length - extname(statePath).length);
  const isConflictCopy = (name: string): boolean =>
    name.startsWith(`${stem}${SYNC_CONFLICT_MARKER}`) || name.startsWith(`${fileName}${SYNC_CONFLICT_MARKER}`);
  let copies: string[];
  try {
    copies = (await readdir(dir)).filter(isConflictCopy).map((name) => join(dir, name));
  } catch {
    return state;
  }
  if (copies.length === 0) return state;

  let merged = state;
  const parsed: string[] = [];
  const corrupt: string[] = [];
  for (const copy of copies) {
    try {
      const raw = JSON.parse(await readFile(copy, "utf8")) as Partial<ProState>;
      merged = mergeProStates(merged, sanitizeProState(raw));
      parsed.push(copy);
    } catch {
      // A corrupt copy has no recoverable data; drop it so conflicts cannot pile up.
      corrupt.push(copy);
    }
  }

  if (parsed.length > 0) {
    try {
      await saveProState(statePath, merged);
    } catch {
      return state; // Keep the copies; the merge retries on the next load.
    }
  }
  await Promise.all([...parsed, ...corrupt].map((copy) => unlink(copy).catch(() => undefined)));
  if (parsed.length > 0) {
    console.warn(`pi-jev-router-pro: merged ${parsed.length} sync-conflict state copies into ${basename(statePath)}`);
  }
  return merged;
}

function mergeProStates(base: ProState, other: ProState): ProState {
  const baseTime = switchTime(base.lastSwitchedAt);
  const otherTime = switchTime(other.lastSwitchedAt);
  // Newest switch wins; on a tie (e.g. both timestamps missing), a defined
  // profile beats an unset one so an empty or corrupt disk state cannot erase
  // an incoming switch.
  const otherWins =
    otherTime > baseTime || (otherTime === baseTime && base.activeProfile === undefined && other.activeProfile !== undefined);
  return {
    version: 1,
    activeProfile: otherWins ? other.activeProfile : base.activeProfile,
    lastSwitchedAt: otherWins ? other.lastSwitchedAt : base.lastSwitchedAt,
    parks: mergeParks(base.parks, other.parks),
    ledger: mergeLedgers(base.ledger, other.ledger),
  };
}

function switchTime(iso: string | undefined): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeParks(base: ParkEntry[], other: ParkEntry[]): ParkEntry[] {
  const untilByKey = new Map<string, number>();
  for (const park of [...base, ...other]) {
    untilByKey.set(park.key, Math.max(untilByKey.get(park.key) ?? 0, park.until));
  }
  return [...untilByKey].map(([key, until]) => ({ key, until }));
}

type SpendBucket = { total: number; byModel: Record<string, number> };

function mergeBuckets(base: SpendBucket | undefined, other: SpendBucket | undefined): SpendBucket | undefined {
  if (!base) return other;
  if (!other) return base;
  const byModel: Record<string, number> = { ...base.byModel };
  for (const [model, usd] of Object.entries(other.byModel ?? {})) {
    byModel[model] = Math.max(byModel[model] ?? 0, usd);
  }
  // `total` is the sum of `byModel` (the recordCost invariant); recompute it so
  // merged buckets with disjoint model keys stay internally consistent.
  const total = round4(Object.values(byModel).reduce((sum, usd) => sum + usd, 0));
  return { total, byModel };
}

function mergeLedgers(base: LedgerData | undefined, other: LedgerData | undefined): LedgerData | undefined {
  if (!base) return other;
  if (!other) return base;
  const days: Record<string, SpendBucket> = {};
  for (const day of new Set([...Object.keys(base.days ?? {}), ...Object.keys(other.days ?? {})])) {
    const bucket = mergeBuckets(base.days?.[day], other.days?.[day]);
    if (bucket) days[day] = bucket;
  }
  const months: Record<string, SpendBucket> = {};
  for (const month of new Set([...Object.keys(base.months ?? {}), ...Object.keys(other.months ?? {})])) {
    const bucket = mergeBuckets(base.months?.[month], other.months?.[month]);
    if (bucket) months[month] = bucket;
  }
  return {
    days,
    months,
    jev: {
      requests: Math.max(base.jev?.requests ?? 0, other.jev?.requests ?? 0),
      inputTokens: Math.max(base.jev?.inputTokens ?? 0, other.jev?.inputTokens ?? 0),
      outputTokens: Math.max(base.jev?.outputTokens ?? 0, other.jev?.outputTokens ?? 0),
    },
    updatedAt: switchTime(base.updatedAt) >= switchTime(other.updatedAt) ? base.updatedAt : other.updatedAt,
  };
}

/**
 * Read-merge-write persist (change 003): merge `incoming` into whatever is on
 * disk right now — never blind-overwrite — then atomically persist the union.
 * Several pi sessions (on one machine or across synced machines) can thus
 * persist concurrently while keeping each other's ledger spend, parks, and the
 * newest profile switch. A missing or corrupt on-disk file degrades to "disk
 * is empty", so `incoming` still persists. Returns the merged state written.
 */
export async function mergeAndSaveState(statePath: string, incoming: ProState): Promise<ProState> {
  let disk: ProState = { version: 1, parks: [] };
  try {
    disk = sanitizeProState(JSON.parse(await readFile(statePath, "utf8")) as Partial<ProState>);
  } catch {
    /* Missing or unreadable: incoming owns the file. */
  }
  const merged = mergeProStates(disk, incoming);
  await saveProState(statePath, merged);
  return merged;
}

export async function saveActiveProfileName(activeProfile: string | undefined, statePath: string, previous: ProState): Promise<ProState> {
  // A switch owns the profile fields, not the ledger: the incoming state
  // carries no ledger, so the merged write keeps whatever concurrent sessions
  // persisted since `previous` was loaded. `lastSwitchedAt` is stamped now for
  // clears too, so a clear is not reverted by an older on-disk switch.
  const next: ProState = {
    ...previous,
    ledger: undefined,
    activeProfile,
    lastSwitchedAt: new Date().toISOString(),
  };
  return await mergeAndSaveState(statePath, next);
}
