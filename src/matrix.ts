import type { RiskScore } from "./types.ts"

const MIN_CONFIDENCE = 0.5

export function computeRisk(scores: { alignment: number; impact: number; confidence: number }): RiskScore {
  const alignmentNorm = scores.alignment / 4
  const impactNorm = scores.impact / 4
  return {
    alignment: scores.alignment,
    impact: scores.impact,
    risk: alignmentNorm * impactNorm,
    confidence: scores.confidence,
  }
}

export function assessThreshold(risk: RiskScore, threshold: number): boolean {
  if (risk.confidence < MIN_CONFIDENCE) return false
  return risk.risk <= threshold
}