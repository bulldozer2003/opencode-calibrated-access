import type { DeterministicFinding, RiskSignalName, SignalScores } from "./types.ts"
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
  | { kind: "ask"; signal: RiskSignalName; probability: number; reason: string; finding?: boolean; justification?: boolean }
  | { kind: "block"; signal: RiskSignalName; probability: number; reason: string; finding?: boolean; justification?: boolean }
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

function findingSignal(findings: DeterministicFinding[]): RiskSignalName {
  const match = findings.find((finding) => (RISK_SIGNALS as readonly string[]).includes(finding.code))
  return (match?.code as RiskSignalName | undefined) ?? "secret_exposure"
}

function findingReason(findings: DeterministicFinding[], summary: string): string {
  const codes = findings.map((finding) => finding.code).join(", ")
  const messages = findings.map((finding) => finding.message).join("; ")
  return `Deterministic finding (${codes}) sets a minimum outcome of ask: ${messages}. ${summary}.`
}

export interface AssessOptions {
  /**
   * True when the retry carries a justification for a previously blocked
   * request. The judge's `user_requested` score is the soundness signal: a
   * high score means the justification is supported by the user's request.
   * A sound justification downgrades a block to an ask; it never allows
   * silently and never bypasses a prohibition or a finding floor.
   */
  justification?: boolean
}

export function assessSignals(
  scores: SignalScores,
  thresholds: Record<RiskSignalName, { block: number; ask: number }>,
  findings: DeterministicFinding[] = [],
  options: AssessOptions = {},
): SignalAssessment {
  const considered = RISK_SIGNALS.filter((signal) => isConsidered(scores.signals[signal])).map((signal) => ({
    signal,
    probability: scores.signals[signal].probability,
  }))
  const hasFinding = findings.length > 0
  const justified = options.justification === true

  if (considered.length === 0) {
    if (hasFinding || justified) {
      return {
        kind: "ask",
        signal: hasFinding ? findingSignal(findings) : "severity",
        probability: 0,
        ...(hasFinding ? { finding: true } : {}),
        ...(justified && !hasFinding ? { justification: true } : {}),
        reason: hasFinding
          ? findingReason(findings, "no risk signal reached the confidence floor")
          : "A justification was supplied but no risk signal reached the confidence floor; confirm with the user.",
      }
    }
    return {
      kind: "unjudged",
      reason: "No risk signal reached the 0.5 confidence floor; the request could not be judged.",
    }
  }

  const blockers = considered.filter((entry) => entry.probability >= thresholds[entry.signal].block)
  const blocker = highest(blockers)
  if (blocker) {
    const userRequested = scores.signals.user_requested
    const sound = isConsidered(userRequested) && userRequested.probability >= USER_REQUESTED_OVERRIDE_THRESHOLD
    const prohibited = blockers.find((entry) => entry.signal === "user_prohibited")
    if (justified && !hasFinding && !prohibited && sound) {
      return {
        kind: "ask",
        signal: blocker.signal,
        probability: blocker.probability,
        justification: true,
        reason: `Justification supported by the user's request; downgraded signal "${blocker.signal}" from block to ask (p=${blocker.probability.toFixed(2)}). Confirm with the user.`,
      }
    }
    const blockSignal = prohibited ?? blocker
    return {
      kind: "block",
      signal: blockSignal.signal,
      probability: blockSignal.probability,
      ...(hasFinding ? { finding: true } : {}),
      reason: `Signal "${blockSignal.signal}" probability ${blockSignal.probability.toFixed(2)} meets the block threshold ${thresholds[blockSignal.signal].block}${prohibited ? " (user prohibition; a justification cannot bypass it)" : ""}.`,
    }
  }

  const askers = considered.filter((entry) => entry.probability >= thresholds[entry.signal].ask)
  const asker = highest(askers)
  if (asker) {
    const userRequested = scores.signals.user_requested
    if (!hasFinding && !justified && isConsidered(userRequested) && userRequested.probability >= USER_REQUESTED_OVERRIDE_THRESHOLD) {
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
      ...(hasFinding ? { finding: true } : {}),
      ...(justified && !hasFinding ? { justification: true } : {}),
      reason: hasFinding
        ? findingReason(findings, `highest signal "${asker.signal}" at ${asker.probability.toFixed(2)}`)
        : justified
          ? `Justification supplied; signal "${asker.signal}" at ${asker.probability.toFixed(2)} stays a confirmation ask (never a silent allow).`
          : `Signal "${asker.signal}" probability ${asker.probability.toFixed(2)} meets the ask threshold ${thresholds[asker.signal].ask}.`,
    }
  }

  const top = highest(considered)
  const summary = top ? `highest signal "${top.signal}" at ${top.probability.toFixed(2)}` : "no signal above zero"
  if (hasFinding) {
    return {
      kind: "ask",
      signal: findingSignal(findings),
      probability: top?.probability ?? 0,
      finding: true,
      reason: findingReason(findings, summary),
    }
  }
  if (justified) {
    return {
      kind: "ask",
      signal: "severity",
      probability: top?.probability ?? 0,
      justification: true,
      reason: `Justification supplied; confirm with the user (${summary}).`,
    }
  }
  return {
    kind: "allow",
    reasonCode: "signals_below_threshold",
    reason: `All safety signals are below the ask threshold (${summary}).`,
  }
}
