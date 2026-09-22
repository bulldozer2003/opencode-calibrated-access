import { describe, expect, test } from "bun:test"
import { computeRisk, assessThreshold } from "../src/matrix.ts"
import type { RiskScore } from "../src/types.ts"

describe("computeRisk", () => {
  test("returns 0 for no alignment or no impact", () => {
    const result = computeRisk({ alignment: 0, impact: 0, confidence: 1 })
    expect(result.risk).toBe(0)
  })

  test("returns 0.25 for medium alignment × medium impact", () => {
    const result = computeRisk({ alignment: 2, impact: 2, confidence: 1 })
    expect(result.risk).toBe(0.25)
  })

  test("returns 0.0625 for low alignment × low impact", () => {
    const result = computeRisk({ alignment: 1, impact: 1, confidence: 1 })
    expect(result.risk).toBeCloseTo(0.0625)
  })

  test("returns 1 for max alignment × max impact", () => {
    const result = computeRisk({ alignment: 4, impact: 4, confidence: 1 })
    expect(result.risk).toBe(1)
  })

  test("carries through alignment, impact, confidence", () => {
    const result = computeRisk({ alignment: 3, impact: 2, confidence: 0.85 })
    expect(result.alignment).toBe(3)
    expect(result.impact).toBe(2)
    expect(result.confidence).toBe(0.85)
  })

  test("user explicitly requested → risk=0 even at max impact", () => {
    const result = computeRisk({ alignment: 0, impact: 4, confidence: 1 })
    expect(result.risk).toBe(0)
  })

  test("autonomous action → risk=impact_norm", () => {
    const result = computeRisk({ alignment: 4, impact: 2, confidence: 1 })
    expect(result.risk).toBe(0.5)
  })

  test("retry after denial → amplified risk", () => {
    const result = computeRisk({ alignment: 3, impact: 3, confidence: 1 })
    expect(result.risk).toBe(0.5625)
  })
})

describe("assessThreshold", () => {
  test("allows risk below threshold with ok confidence", () => {
    expect(assessThreshold({ alignment: 1, impact: 1, risk: 0.0625, confidence: 0.8 }, 0.4)).toBe(true)
  })

  test("rejects risk above threshold", () => {
    expect(assessThreshold({ alignment: 3, impact: 3, risk: 0.5625, confidence: 0.8 }, 0.4)).toBe(false)
  })

  test("rejects low confidence even if risk is low", () => {
    expect(assessThreshold({ alignment: 1, impact: 1, risk: 0.0625, confidence: 0.3 }, 0.4)).toBe(false)
  })

  test("accepts borderline risk at exact threshold", () => {
    expect(assessThreshold({ alignment: 2, impact: 2, risk: 0.25, confidence: 0.8 }, 0.25)).toBe(true)
  })
})