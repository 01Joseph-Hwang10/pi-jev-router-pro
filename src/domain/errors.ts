import type { RouteAnalysis } from "../jev/client.js";
import type { StoredJudgment } from "./types.js";

/**
 * Failure classification for the retry path (constitution §5, spec R4, R5):
 * transient errors fall forward, permanent errors park, context overflow
 * stays sticky, and unknown errors advance without parking.
 */

export type FailureKind = "transient" | "permanent" | "overflow" | "unknown";

/** Context overflow is never a fallback trigger; pi's compaction recovery owns it (R4.5). */
const OVERFLOW_PATTERN =
  /context.{0,24}(length|window|overflow|too large|exceeded)|too many.{0,24}tokens|maximum.{0,24}context|context_length_exceeded|prompt is too long|request too large|exceeds.{0,32}(context|token)/i;

/** Transient failures advance the chain (R4.1): 429, 5xx, 529, rate-limit, timeout, network. */
const TRANSIENT_PATTERN =
  /\b429\b|\b5\d\d\b|\b529\b|rate.?limit|overload|overloaded|temporar|timeout|timed.?out|network|econn|socket|fetch failed|service unavailable|bad gateway|gateway timeout|internal server error|connection (error|reset|refused)|try again/i;

/**
 * Require the failed model's identity and an explicit unavailability, not a
 * bare HTTP status (R5.2). Ported from the legacy `isModelUnavailable` guard,
 * extended with auth failures (401/403) that name the model.
 */
export function isModelUnavailable(error: string, model: string): boolean {
  if (!model || !error.includes(model)) return false;
  if (/\b(?:429|5\d\d|529)\b|rate.?limit|overload|temporar|timeout|timed.?out|network/i.test(error)) return false;
  return (
    /\b(?:401|403)\b|model_not_found|model[^\n]*(?:not found|does not exist|no longer available|decommissioned|retired|withdrawn)|(?:decommissioned|retired|withdrawn)[^\n]*model|invalid model|unknown model/i.test(
      error,
    )
  );
}

export class JevChainExhausted extends Error {
  constructor(
    readonly attempted: string[],
    readonly originalError?: string,
  ) {
    super(
      [
        "jev-router-pro: model chain exhausted for this turn.",
        attempted.length > 0 ? `Attempted: ${attempted.join(", ")}.` : "No eligible model was available.",
        originalError ? `Last error: ${originalError}` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
    );
    this.name = "JevChainExhausted";
  }
}

/** Classify a failed request's error message (design §3, `retry` row). */
export function classifyFailure(errorMessage: string, failedModelKey: string): FailureKind {
  const text = errorMessage ?? "";
  if (OVERFLOW_PATTERN.test(text)) return "overflow";
  if (TRANSIENT_PATTERN.test(text)) return "transient";
  if (isModelUnavailable(text, failedModelKey.split("/").pop() ?? "") || isModelUnavailable(text, failedModelKey)) return "permanent";
  return "unknown";
}

/** JSON-safe judgment snapshot kept in router state. */
export function toStoredJudgment(analysis: RouteAnalysis): StoredJudgment {
  return {
    kind: analysis.kind,
    kindConfidence: analysis.kindConfidence,
    complexity: analysis.complexity,
    budgetIntensity: analysis.budgetIntensity,
    deepReasoning: analysis.deepReasoning,
  };
}
