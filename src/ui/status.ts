import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatUsd, type SpendSnapshot } from "../routing/budget.js";
import type { RouteDecision } from "../routing/router.js";

/**
 * Status-bar widget (R8.4): `jev-auto: <profile>` plus the last dispatch.
 * Cosmetic and optional; every sink is feature-detected.
 */

export const STATUS_KEY = "jev-auto";

export function setStatusText(ctx: ExtensionContext, text: string | undefined): void {
  try {
    ctx.ui?.setStatus?.(STATUS_KEY, text);
  } catch {
    // Ignore UI failures.
  }
}

export function statusLine(profile: string | undefined, decision: RouteDecision | undefined, spend: SpendSnapshot, dormant: boolean): string {
  if (dormant) return `jev-auto: ${profile ?? "off"} · dormant`;
  const parts = [`jev-auto: ${profile ?? "off"}`];
  if (decision) parts.push(`${decision.tier} → ${decision.model.provider}/${decision.model.id}`);
  if (spend.today > 0) parts.push(formatUsd(spend.today));
  if (spend.pressure > 0) parts.push(`${Math.round(spend.pressure * 100)}%`);
  return parts.join(" · ");
}

export function updateStatus(ctx: ExtensionContext, profile: string | undefined, decision: RouteDecision | undefined, spend: SpendSnapshot, dormant: boolean): void {
  setStatusText(ctx, statusLine(profile, decision, spend, dormant));
}

export function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui?.notify?.(text, level);
  } catch {
    // Ignore UI failures.
  }
}
