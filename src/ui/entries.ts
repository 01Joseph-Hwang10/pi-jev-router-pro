import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RouteDecision } from "../routing/router.js";
import type { StoredJudgment } from "../domain/types.js";

/**
 * Decision transcript entries (R2.2, constitution §3): every routing decision
 * is visible with an action glyph, tier, dispatched model, and judgment
 * summary — expandable to the raw judgment. Durable, never sent to the LLM.
 */

export const ENTRY_TYPE = "jev-auto-decision";

export type EntryAction = "switched" | "kept" | "notified" | "skipped" | "fallback";

export interface DecisionEntryData {
  action: EntryAction;
  tier: string;
  /** Dispatched physical model, `provider/model`. */
  model: string;
  kind: string;
  kindConfidence: number;
  complexity: number;
  capability: number;
  deepReasoning: number;
  /** Budget pressure at decision time, 0 when no caps are set. */
  pressure: number;
  reason: string;
  notes: string[];
  at: number;
}

const GLYPHS: Record<EntryAction, string> = {
  switched: "→",
  kept: "=",
  notified: "•",
  skipped: "×",
  fallback: "↻",
};

export function formatAnalysis(judgment: StoredJudgment): string {
  return (
    `kind ${judgment.kind} (conf ${judgment.kindConfidence.toFixed(2)}) · ` +
    `complexity ${judgment.complexity.toFixed(2)}/3 · capability ${judgment.budgetIntensity.toFixed(2)}/3 · ` +
    `deep reasoning ${(judgment.deepReasoning * 100).toFixed(0)}%`
  );
}

export function entryDataFromDecision(decision: RouteDecision, pressure: number): DecisionEntryData {
  const judgment = decision.analysis;
  return {
    action: decision.action,
    tier: decision.tier,
    model: `${decision.model.provider}/${decision.model.id}`,
    kind: judgment?.kind ?? decision.failure?.kind ?? "none",
    kindConfidence: judgment?.kindConfidence ?? 0,
    complexity: judgment?.complexity ?? 0,
    capability: judgment?.budgetIntensity ?? 0,
    deepReasoning: judgment?.deepReasoning ?? 0,
    pressure,
    reason: decision.reason,
    notes: [...decision.notes],
    at: Date.now(),
  };
}

/** appendEntry is optional across pi builds; entries are a nice-to-have. */
export function makeEntryAppender(api: ExtensionAPI, dedupe = true): (data: DecisionEntryData) => void {
  let lastSignature: string | undefined;
  return (data: DecisionEntryData) => {
    if (typeof api.appendEntry !== "function") return;
    const signature = `${data.action}|${data.model}|${data.reason}|${data.notes.join("|")}`;
    if (dedupe && lastSignature === signature) return;
    lastSignature = signature;
    try {
      api.appendEntry<DecisionEntryData>(ENTRY_TYPE, data);
    } catch {
      // Never let durable entries break routing.
    }
  };
}

/**
 * TUI renderer. Feature-detected at load: `registerEntryRenderer` and the
 * pi-tui components are not available in every build, and rendering must
 * never break extension load.
 */
export async function registerEntryRenderer(api: ExtensionAPI): Promise<void> {
  if (typeof api.registerEntryRenderer !== "function") return;
  try {
    const { Box, Text } = await import("@earendil-works/pi-tui");
    api.registerEntryRenderer<DecisionEntryData>(ENTRY_TYPE, (entry, { expanded }, theme) => {
      const data = entry.data;
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      if (!data) {
        box.addChild(new Text(theme.fg("dim", "jev-auto: no decision data"), 0, 0));
        return box;
      }
      const glyph = GLYPHS[data.action] ?? "·";
      const label = `${theme.fg("accent", `jev-auto ${glyph} ${data.tier}`)}  ${theme.bold(data.model)}`;
      box.addChild(new Text(label, 0, 0));
      box.addChild(new Text(theme.fg("dim", data.reason), 0, 0));
      if (data.notes.length > 0) {
        box.addChild(new Text(theme.fg("dim", data.notes.map((note) => `· ${note}`).join("\n")), 0, 0));
      }
      if (expanded) {
        box.addChild(
          new Text(
            theme.fg(
              "dim",
              formatAnalysis({
                kind: data.kind,
                kindConfidence: data.kindConfidence,
                complexity: data.complexity,
                budgetIntensity: data.capability,
                deepReasoning: data.deepReasoning,
              }) + (data.pressure > 0 ? ` · budget ${(data.pressure * 100).toFixed(0)}% of cap` : ""),
            ),
            0,
            0,
          ),
        );
      }
      return box;
    });
  } catch {
    // TUI rendering unavailable in this build: decisions still persist as
    // session entries and surface through the status bar and notify.
  }
}
