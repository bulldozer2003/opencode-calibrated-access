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
    user_prohibited: { probability: 0, confidence: 1 },
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
        user_prohibited: { probability: 1, confidence: 0.4 },
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
        user_prohibited: { probability: 1, confidence: 0.4 },
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

  test("user_prohibited defaults to block 0.7 / ask 0.5", () => {
    expect(DEFAULT_SIGNAL_THRESHOLDS.user_prohibited).toEqual({ block: 0.7, ask: 0.5 })
  })

  test("block-tier: user_prohibited 0.7 blocks", () => {
    const result = assessSignals(scores({ user_prohibited: { probability: 0.7, confidence: 0.9 } }), DEFAULT_SIGNAL_THRESHOLDS)
    expect(result.kind).toBe("block")
    if (result.kind !== "block") throw new Error("expected block")
    expect(result.signal).toBe("user_prohibited")
    expect(result.probability).toBe(0.7)
  })

  test("ask-tier: user_prohibited 0.55 asks", () => {
    const result = assessSignals(scores({ user_prohibited: { probability: 0.55, confidence: 0.9 } }), DEFAULT_SIGNAL_THRESHOLDS)
    expect(result.kind).toBe("ask")
    if (result.kind !== "ask") throw new Error("expected ask")
    expect(result.signal).toBe("user_prohibited")
  })

  test("a command both requested and prohibited resolves conservatively — prohibited wins at block threshold", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.65, confidence: 0.9 },
        user_requested: { probability: 0.95, confidence: 0.9 },
        user_prohibited: { probability: 0.7, confidence: 0.9 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(result.kind).toBe("block")
    if (result.kind !== "block") throw new Error("expected block")
    expect(result.signal).toBe("user_prohibited")
  })

  test("user_requested override never downgrades a user_prohibited block", () => {
    const result = assessSignals(
      scores({
        user_requested: { probability: 1, confidence: 1 },
        user_prohibited: { probability: 0.9, confidence: 1 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(result.kind).toBe("block")
    if (result.kind !== "block") throw new Error("expected block")
    expect(result.signal).toBe("user_prohibited")
  })
})

describe("assessSignals — deterministic finding floor", () => {
  const finding = {
    code: "secret_exposure" as const,
    severity: "caution" as const,
    message: "caution: command matches a secret-file-read pattern (.env)",
  }

  test("a finding turns a below-threshold allow into ask", () => {
    const result = assessSignals(scores({ destructive: { probability: 0.2, confidence: 0.9 } }), DEFAULT_SIGNAL_THRESHOLDS, [finding])
    expect(result.kind).toBe("ask")
    if (result.kind !== "ask") throw new Error("expected ask")
    expect(result.finding).toBe(true)
    expect(result.reason).toContain("Deterministic finding")
    expect(result.reason).toContain("secret_exposure")
  })

  test("a finding blocks the user_requested ask→allow downgrade", () => {
    const withoutFinding = assessSignals(
      scores({
        destructive: { probability: 0.65, confidence: 0.9 },
        user_requested: { probability: 0.95, confidence: 0.95 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(withoutFinding.kind).toBe("allow")

    const withFinding = assessSignals(
      scores({
        destructive: { probability: 0.65, confidence: 0.9 },
        user_requested: { probability: 0.95, confidence: 0.95 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
      [finding],
    )
    expect(withFinding.kind).toBe("ask")
    if (withFinding.kind !== "ask") throw new Error("expected ask")
    expect(withFinding.finding).toBe(true)
  })

  test("a finding turns an unjudged request into ask", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 1, confidence: 0.4 },
        secret_exposure: { probability: 1, confidence: 0.4 },
        exfiltration: { probability: 1, confidence: 0.4 },
        prompt_injection: { probability: 1, confidence: 0.4 },
        scope_creep: { probability: 1, confidence: 0.4 },
        user_prohibited: { probability: 1, confidence: 0.4 },
        severity: { probability: 1, confidence: 0.4 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
      [finding],
    )
    expect(result.kind).toBe("ask")
    if (result.kind !== "ask") throw new Error("expected ask")
    expect(result.finding).toBe(true)
  })

  test("finding + model agreement blocks rather than asks", () => {
    const result = assessSignals(scores({ secret_exposure: { probability: 0.9, confidence: 0.9 } }), DEFAULT_SIGNAL_THRESHOLDS, [finding])
    expect(result.kind).toBe("block")
    if (result.kind !== "block") throw new Error("expected block")
    expect(result.finding).toBe(true)
  })

  test("a finding cannot be silently allowed", () => {
    const result = assessSignals(scores({}), DEFAULT_SIGNAL_THRESHOLDS, [finding])
    expect(result.kind).not.toBe("allow")
  })
})

describe("assessSignals — justified retry downgrade", () => {
  const finding = {
    code: "secret_exposure" as const,
    severity: "caution" as const,
    message: "caution: command matches a secret-file-read pattern (.env)",
  }

  test("a sound justification downgrades a block to ask", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.9, confidence: 0.9 },
        user_requested: { probability: 0.9, confidence: 0.9 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
      [],
      { justification: true },
    )
    expect(result.kind).toBe("ask")
    if (result.kind !== "ask") throw new Error("expected ask")
    expect(result.reason).toContain("ustification")
  })

  test("a justified retry never silently allows", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.9, confidence: 0.9 },
        user_requested: { probability: 0.95, confidence: 0.95 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
      [],
      { justification: true },
    )
    expect(result.kind).toBe("ask")
  })

  test("a justified ask-tier request stays ask, not allow", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.65, confidence: 0.9 },
        user_requested: { probability: 0.95, confidence: 0.95 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
      [],
      { justification: true },
    )
    expect(result.kind).toBe("ask")
  })

  test("an unsound justification (low user_requested) leaves the block", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.9, confidence: 0.9 },
        user_requested: { probability: 0.4, confidence: 0.9 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
      [],
      { justification: true },
    )
    expect(result.kind).toBe("block")
  })

  test("a justified retry never bypasses a user_prohibited block", () => {
    const result = assessSignals(
      scores({
        user_prohibited: { probability: 0.9, confidence: 0.9 },
        user_requested: { probability: 0.9, confidence: 0.9 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
      [],
      { justification: true },
    )
    expect(result.kind).toBe("block")
    if (result.kind !== "block") throw new Error("expected block")
    expect(result.signal).toBe("user_prohibited")
  })

  test("a justified retry never bypasses a user_prohibited block even when another signal is higher", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.95, confidence: 0.9 },
        user_prohibited: { probability: 0.85, confidence: 0.9 },
        user_requested: { probability: 0.9, confidence: 0.9 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
      [],
      { justification: true },
    )
    expect(result.kind).toBe("block")
    if (result.kind !== "block") throw new Error("expected block")
    expect(result.signal).toBe("user_prohibited")
  })

  test("a justified retry never bypasses a finding floor", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.9, confidence: 0.9 },
        user_requested: { probability: 0.9, confidence: 0.9 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
      [finding],
      { justification: true },
    )
    expect(result.kind).toBe("block")
    if (result.kind !== "block") throw new Error("expected block")
    expect(result.finding).toBe(true)
  })

  test("a justified unjudged request asks rather than blocks", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 1, confidence: 0.4 },
        secret_exposure: { probability: 1, confidence: 0.4 },
        exfiltration: { probability: 1, confidence: 0.4 },
        prompt_injection: { probability: 1, confidence: 0.4 },
        scope_creep: { probability: 1, confidence: 0.4 },
        user_prohibited: { probability: 1, confidence: 0.4 },
        severity: { probability: 1, confidence: 0.4 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
      [],
      { justification: true },
    )
    expect(result.kind).toBe("ask")
  })

  test("a justified block is not downgraded when the justification is absent", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.9, confidence: 0.9 },
        user_requested: { probability: 0.95, confidence: 0.95 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(result.kind).toBe("block")
  })

  test("the user_requested ask→allow override still applies without a justification", () => {
    const result = assessSignals(
      scores({
        destructive: { probability: 0.65, confidence: 0.9 },
        user_requested: { probability: 0.95, confidence: 0.95 },
      }),
      DEFAULT_SIGNAL_THRESHOLDS,
    )
    expect(result.kind).toBe("allow")
  })
})
