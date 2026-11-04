import { describe, expect, it } from "vitest";
import { classifyFailure, isModelUnavailable, JevChainExhausted } from "../src/domain/errors.js";

/** R4/R5 failure classification: transient → advance, permanent → park, overflow → sticky. */

describe("classifyFailure", () => {
  it("treats 429, 5xx, 529, rate-limit and timeouts as transient (R4.1)", () => {
    for (const message of [
      "HTTP 429 Too Many Requests",
      "Provider error: 500 Internal Server Error",
      "TypeSafe overloaded (529)",
      "rate limit exceeded for org",
      "request timed out after 30s",
      "network error: socket hang up",
      "service temporarily unavailable",
    ]) {
      expect(classifyFailure(message, "p/m1")).toBe("transient");
    }
  });

  it("treats context overflow as its own class — never a fallback trigger (R4.5)", () => {
    for (const message of [
      "prompt is too long: 200000 tokens > 128000 maximum context",
      "context_length_exceeded",
      "request too large for this model's context window",
    ]) {
      expect(classifyFailure(message, "p/m1")).toBe("overflow");
    }
  });

  it("parks permanent unavailability only with the model's identity (R5.2)", () => {
    expect(classifyFailure("model p/m1 was retired by the provider", "p/m1")).toBe("permanent");
    expect(classifyFailure(`401 Unauthorized for model m1`, "p/m1")).toBe("permanent");
    expect(classifyFailure("model_not_found: m1", "p/m1")).toBe("permanent");
    expect(classifyFailure("model m1 does not exist", "p/m1")).toBe("permanent");
    // Bare status or unavailability wording without identity: no parking (R5.2).
    expect(classifyFailure("401 Unauthorized", "p/m1")).toBe("unknown");
    expect(classifyFailure("this model does not exist", "p/m1")).toBe("unknown");
    expect(isModelUnavailable("401 Unauthorized", "m1")).toBe(false);
  });

  it("keeps transient wording winning over identity", () => {
    expect(classifyFailure("m1 overloaded (429), try again", "p/m1")).toBe("transient");
  });

  it("returns unknown for unclassifiable errors", () => {
    expect(classifyFailure("something odd happened", "p/m1")).toBe("unknown");
  });
});

describe("JevChainExhausted (R4.4)", () => {
  it("lists attempts and the original error, exactly once", () => {
    const error = new JevChainExhausted(["p/a", "p/b"], "HTTP 429");
    expect(error.name).toBe("JevChainExhausted");
    expect(error.message).toContain("p/a, p/b");
    expect(error.message).toContain("HTTP 429");
  });
});
