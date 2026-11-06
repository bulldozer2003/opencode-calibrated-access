import { describe, expect, test } from "bun:test"
import { assessSignals, DEFAULT_SIGNAL_THRESHOLDS } from "../src/matrix.ts"
import type { SignalName, SignalScores } from "../src/types.ts"

function scores(overrides: Partial<Record<SignalName, { probability: number; confidence: number }>>): SignalScores {
  const base: Record<SignalName, { probability: number; confidence: number }> = {
    destructive: { probability: 0, confidence: 1 },
    secret_exposure: { probability: 0, confidence: 1 },
    exfiltration: { probability: 0, confidence: 1 },
    prompt_injection: { probability: 0, confidence: 1 },
    scope_creep: { probability: 0, confidence: 1 },
    user_requested: { probability: 0, confidence: 1 },
    severity: { probability: 0, confidence: 1 },
  }
  return { signals: { ...base, ...overrides } }
}

describe("assessSignals", () => {
  test("block-tier: destructive 0.9 blocks", () => {
    const result = assessSignals(scores({ destructive: { probability: 0.9, confidence: 0.9 } }), DEFAULT_SIGNAL_THRESHOLDS)
    expect(result.kind).toBe("block")
    if (result.kind !== "block") throw new Error("expected block")
    expect(result.signal).toBe("destructive")
    expect(result.probability).toBe(0.9)
  })

  test("below-threshold: all signals low allows with signals_below_threshold", () => {
    const result = assessSignals(scores({ destructive: { probability: 0.2, confidence: 0.9 } }), DEFAULT_SIGNAL_THRESHOLDS)
    expect(result.kind).toBe("allow")
    if (result.kind !== "allow") throw new Error("expected allow")
    expect(result.reasonCode).toBe("signals_below_threshold")
  })

  test("ask-tier: destructive 0.65 asks", () => {
    const result = assessSignals(scores({ destructive: { probability: 0.65, confidence: 0.9 } }), DEFAULT_SIGNAL_THRESHOLDS)
    expect(result.kind).toBe("ask")
    if (result.kind !== "ask") throw new Error("expected ask")
    expect(result.signal).toBe("destructive")
    expect(result.probability).toBe(0.65)
  })

  test("confidence gate: ignores high-probability signal below 0.5 confidence", () => {
    const result = assessSignals(scores({ destructive: { probability: 0.99, confidence: 0.4 } }), DEFAULT_SIGNAL_THRESHOLDS)
    expect(result.kind).toBe("allow")
  })

  test("highest-offender tie-break: picks the most probable offender", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.9, confidence: 0.9 },
        exfiltration: { probability: 0.95, confidence: 0.9 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(result.kind).toBe("block")
    if (result.kind !== "block") throw new Error("expected block")
    expect(result.signal).toBe("exfiltration")
    expect(result.probability).toBe(0.95)
  })

  test("user_requested downgrades an ask-tier deny to allow", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.65, confidence: 0.9 },
        user_requested: { probability: 0.9, confidence: 0.9 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(result.kind).toBe("allow")
    if (result.kind !== "allow") throw new Error("expected allow")
    expect(result.reasonCode).toBe("user_requested_override")
    expect(result.reason).toContain("destructive")
  })

  test("user_requested never downgrades a block-tier deny", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.9, confidence: 0.9 },
        user_requested: { probability: 1, confidence: 1 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(result.kind).toBe("block")
  })

  test("unjudged: blocks when every risk signal is below the 0.5 confidence floor", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 1, confidence: 0.4 },
        secret_exposure: { probability: 1, confidence: 0.4 },
        exfiltration: { probability: 1, confidence: 0.4 },
        prompt_injection: { probability: 1, confidence: 0.4 },
        scope_creep: { probability: 1, confidence: 0.4 },
        severity: { probability: 1, confidence: 0.4 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(result.kind).toBe("unjudged")
    expect(result.kind).not.toBe("allow")
  })

  test("unjudged: a confident, high-probability user_requested does not rescue it", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 1, confidence: 0.4 },
        secret_exposure: { probability: 1, confidence: 0.4 },
        exfiltration: { probability: 1, confidence: 0.4 },
        prompt_injection: { probability: 1, confidence: 0.4 },
        scope_creep: { probability: 1, confidence: 0.4 },
        severity: { probability: 1, confidence: 0.4 },
        user_requested: { probability: 0.9, confidence: 0.9 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(result.kind).toBe("unjudged")
  })

  test("unjudged does not fire when at least one risk signal is confident", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.2, confidence: 0.9 },
        secret_exposure: { probability: 1, confidence: 0.4 },
        exfiltration: { probability: 1, confidence: 0.4 },
        prompt_injection: { probability: 1, confidence: 0.4 },
        scope_creep: { probability: 1, confidence: 0.4 },
        severity: { probability: 1, confidence: 0.4 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(result.kind).toBe("allow")
    if (result.kind !== "allow") throw new Error("expected allow")
    expect(result.reasonCode).toBe("signals_below_threshold")
  })

  test("user_requested override requires >= 0.8 probability and >= 0.5 confidence", () => {
    const lowProbability = assessSignals(
      scores({
        destructive: { probability: 0.65, confidence: 0.9 },
        user_requested: { probability: 0.79, confidence: 0.9 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(lowProbability.kind).toBe("ask")

    const lowConfidence = assessSignals(
      scores({
        destructive: { probability: 0.65, confidence: 0.9 },
        user_requested: { probability: 0.95, confidence: 0.4 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(lowConfidence.kind).toBe("ask")
  })
})
