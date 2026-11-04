import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ParkEntry } from "../domain/types.js";

/**
 * Persisted TTL parking for permanently-failed model targets
 * (constitution §5). Ported from the legacy router's `Parking`.
 */
export class Parking {
  private readonly entries = new Map<string, number>();

  constructor(
    loadEntries: () => ParkEntry[],
    private readonly saveEntries: (entries: ParkEntry[]) => boolean,
    entries?: ParkEntry[],
  ) {
    for (const park of entries ?? loadEntries()) {
      if (typeof park?.key === "string" && park.key.includes("/") && typeof park.until === "number" && Number.isFinite(park.until) && park.until <= 8.64e15) {
        this.entries.set(park.key, park.until);
      }
    }
  }

  has(key: string, now = Date.now()): boolean {
    return (this.entries.get(key) ?? 0) > now;
  }

  list(now = Date.now()): string[] {
    return [...this.entries]
      .filter(([, until]) => until > now)
      .map(([key, until]) => `${key} parked until ${new Date(until).toISOString()}`);
  }

  park(key: string, parkMs: number, now = Date.now()): boolean {
    this.entries.set(key, Math.min(8.64e15, now + parkMs));
    return this.save(now);
  }

  clear(): boolean {
    this.entries.clear();
    return this.save();
  }

  entriesForSave(now = Date.now()): ParkEntry[] {
    return [...this.entries]
      .filter(([, until]) => until > now)
      .map(([key, until]) => ({ key, until }));
  }

  private save(now = Date.now()): boolean {
    return this.saveEntries(this.entriesForSave(now));
  }
}

/**
 * Standalone file-backed parking store, used when the caller does not own a
 * wider state file. Writes are atomic; corruption degrades to "no parks".
 */
export function fileParking(file: string): Parking {
  const load = (): ParkEntry[] => {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data?.version !== 1 || !Array.isArray(data.parks)) return [];
      return data.parks as ParkEntry[];
    } catch {
      return [];
    }
  };
  const save = (entries: ParkEntry[]): boolean => {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(temp, JSON.stringify({ version: 1, parks: entries }), { mode: 0o600 });
      renameSync(temp, file);
      return true;
    } catch {
      return false;
    } finally {
      try {
        rmSync(temp, { force: true });
      } catch {
        /* Best-effort cleanup. */
      }
    }
  };
  return new Parking(load, save);
}
