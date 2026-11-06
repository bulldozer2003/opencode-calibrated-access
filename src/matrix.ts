import type { RiskSignalName, SignalScores } from "./types.ts"
import { SIGNAL_NAMES } from "./types.ts"

const MIN_CONFIDENCE = 0.5
const USER_REQUESTED_OVERRIDE_THRESHOLD = 0.8

export const DEFAULT_SIGNAL_THRESHOLDS = {
  destructive: { block: 0.85, ask: 0.6 },
  secret_exposure: { block: 0.7, ask: 0.5 },
  exfiltration: { block: 0.7, ask: 0.5 },
  prompt_injection: { block: 0.7, ask: 0.5 },
  scope_creep: { block: 0.8, ask: 0.6 },
  user_prohibited: { block: 0.7, ask: 0.5 },
  severity: { block: 0.85, ask: 0.6 },
} satisfies Record<RiskSignalName, { block: number; ask: number }>

export type SignalAssessment =
  | { kind: "allow"; reasonCode: "signals_below_threshold"; reason: string }
  | { kind: "allow"; reasonCode: "user_requested_override"; reason: string }
  | { kind: "ask"; signal: RiskSignalName; probability: number; reason: string }
  | { kind: "block"; signal: RiskSignalName; probability: number; reason: string }
  | { kind: "unjudged"; reason: string }

const RISK_SIGNALS = SIGNAL_NAMES.filter((name): name is RiskSignalName => name !== "user_requested")

function isConsidered(entry: { probability: number; confidence: number } | undefined): boolean {
  return entry !== undefined && entry.confidence >= MIN_CONFIDENCE
}

function highest(entries: Array<{ signal: RiskSignalName; probability: number }>): { signal: RiskSignalName; probability: number } | undefined {
  let best: { signal: RiskSignalName; probability: number } | undefined
  for (const entry of entries) {
    if (!best || entry.probability > best.probability) best = entry
  }
  return best
}

export function assessSignals(
  scores: SignalScores,
  thresholds: Record<RiskSignalName, { block: number; ask: number }>,
): SignalAssessment {
  const considered = RISK_SIGNALS.filter((signal) => isConsidered(scores.signals[signal])).map((signal) => ({
    signal,
    probability: scores.signals[signal].probability,
  }))

  if (considered.length === 0) {
    return {
      kind: "unjudged",
      reason: "No risk signal reached the 0.5 confidence floor; the request could not be judged.",
    }
  }

  const blockers = considered.filter((entry) => entry.probability >= thresholds[entry.signal].block)
  const blocker = highest(blockers)
  if (blocker) {
    return {
      kind: "block",
      signal: blocker.signal,
      probability: blocker.probability,
      reason: `Signal "${blocker.signal}" probability ${blocker.probability.toFixed(2)} meets the block threshold ${thresholds[blocker.signal].block}.`,
    }
  }

  const askers = considered.filter((entry) => entry.probability >= thresholds[entry.signal].ask)
  const asker = highest(askers)
  if (asker) {
    const userRequested = scores.signals.user_requested
    if (isConsidered(userRequested) && userRequested.probability >= USER_REQUESTED_OVERRIDE_THRESHOLD) {
      return {
        kind: "allow",
        reasonCode: "user_requested_override",
        reason: `User explicitly requested this action; downgraded signal "${asker.signal}" (p=${asker.probability.toFixed(2)}).`,
      }
    }
    return {
      kind: "ask",
      signal: asker.signal,
      probability: asker.probability,
      reason: `Signal "${asker.signal}" probability ${asker.probability.toFixed(2)} meets the ask threshold ${thresholds[asker.signal].ask}.`,
    }
  }

  const top = highest(considered)
  const summary = top ? `highest signal "${top.signal}" at ${top.probability.toFixed(2)}` : "no signal above zero"
  return {
    kind: "allow",
    reasonCode: "signals_below_threshold",
    reason: `All safety signals are below the ask threshold (${summary}).`,
  }
}
