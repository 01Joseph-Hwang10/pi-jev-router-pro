import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Mode, ProConfig } from "../domain/types.js";
import type { AvailableModel } from "../domain/chain.js";
import type { RouteDecision } from "../routing/router.js";
import type { ProRouterRuntime } from "../profiles/switcher.js";
import type { SpendSnapshot } from "../routing/budget.js";

/**
 * Structural view of the live extension runtime that command handlers need.
 * `index.ts` provides the concrete implementation; commands stay decoupled
 * from the wiring (and unit-testable).
 */
export interface ProCommandsContext {
  readonly runtime: ProRouterRuntime;
  readonly proConfig: ProConfig;

  /** Catalogue snapshot (`ctx.modelRegistry.getAvailable()`). */
  getModels(): AvailableModel[];
  refreshModels(ctx: ExtensionContext): void;

  /** Consent / enablement session overrides. */
  mode(): Mode;
  setMode(mode: Mode): void;
  enabled(): boolean;
  setEnabled(enabled: boolean): void;

  /** Dormancy (constitution §2): manual physical selection parks the router. */
  isDormant(): boolean;
  /** Re-select the virtual model and clear dormancy (`/jev auto`). */
  activateVirtual(ctx: ExtensionContext): Promise<boolean>;
  virtualModelKey(): string;

  /** Last dispatch, for the status widget and `/jev-router`. */
  lastDecision(): RouteDecision | undefined;
  recordDecision(decision: RouteDecision): void;

  spend(): SpendSnapshot;
  quotaLines(): { summary: string; detail: string[] };
}

export interface AnalyseResult {
  analysisText: string;
  decisionText: string;
  ok: boolean;
  error?: string;
}

/** `/jev-route <text>`: classify preview without switching (R2/R8). */
export interface RoutePreview {
  analyse(text: string, ctx: ExtensionContext): Promise<AnalyseResult>;
}
