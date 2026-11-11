import type { DeterministicFinding, RiskSignalName, SignalName, SignalScores } from "./types.ts"
import { SIGNAL_NAMES } from "./types.ts"
import { DEFAULT_SIGNAL_THRESHOLDS, assessSignals } from "./matrix.ts"
import { parseConfig } from "./config.ts"

export type EffectiveOutcome = "allow" | "ask" | "block" | "unknown"

export type ThresholdMap = Record<RiskSignalName, { block: number; ask: number }>

export interface SignalEntry {
  probability: number
  confidence: number
}

export type SignalMap = Partial<Record<SignalName, SignalEntry>>

export const RISK_SIGNAL_NAMES: readonly RiskSignalName[] = SIGNAL_NAMES.filter(
  (name): name is RiskSignalName => name !== "user_requested",
)

export const DEFAULT_NEAR_MARGIN = 0.15

export const DEFAULT_THRESHOLD_GRID: readonly number[] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]

const SHADOW_PREFIX = "shadow_"
const NON_MODEL_SOURCES = new Set(["policy", "session", "error", "appeal"])

/**
 * Every reason code the plugin can emit with a `shadow_` prefix — the shadow
 * projection of a would-be outcome. Enumerated so the calibration reader can
 * never silently fall through a newly added shadow code: the source-scan test
 * in test/calibration.test.ts fails when a concrete `shadow_*` literal appears
 * in src/ without being listed here, and each entry is asserted to map to the
 * enforce-mode outcome its stripped code produces.
 */
export const SHADOW_REASON_CODES: readonly string[] = [
  "shadow_ask",
  "shadow_block",
  "shadow_unjudged",
  "shadow_appeal_exhausted",
  "shadow_unjustified_retry",
]

export interface DecisionRecord {
  lineIndex: number
  timestamp?: string
  sessionID: string
  action: string
  command: string
  source: string
  mode?: string
  promptVersion?: string
  decision: string
  reasonCode: string
  outcome: EffectiveOutcome
  justified: boolean
  signals: SignalMap
  findings: DeterministicFinding[]
}

export interface ResumeRecord {
  lineIndex: number
  sessionID: string
  ok: boolean
  started?: boolean
  attempt?: number
}

export interface ParsedDiagnostics {
  totalEvents: number
  malformedLines: number
  decisions: DecisionRecord[]
  resumes: ResumeRecord[]
}

/**
 * Derives the enforce-mode outcome a decision event would have produced, reading
 * through the `shadow_` prefix that shadow mode records on every event. The
 * recorded `decision` is always `allow` in shadow mode, so the reason code is the
 * only place the would-be ask/block verdict survives.
 */
export function effectiveOutcome(decision: string, reasonCode: string): EffectiveOutcome {
  const code = reasonCode.startsWith(SHADOW_PREFIX) ? reasonCode.slice(SHADOW_PREFIX.length) : reasonCode
  if (code === "review_failed") return decision === "allow" ? "allow" : "block"
  if (code === "signals_below_threshold" || code === "user_requested_override" || code === "session_approval_reused") {
    return "allow"
  }
  if (code === "secret_exposure") return "block"
  if (
    code === "no_confident_signals" ||
    code === "unjudged" ||
    code === "catastrophic_delete" ||
    code === "explicit_user_prohibition" ||
    code === "appeal_exhausted" ||
    code === "unjustified_retry"
  ) {
    return "block"
  }
  if (code.startsWith("signal_block_") || code === "block") return "block"
  if (code.startsWith("signal_ask_") || code === "ask") return "ask"
  return decision === "allow" ? "allow" : "block"
}

export function parseCalibrationEvents(lines: readonly string[]): ParsedDiagnostics {
  const decisions: DecisionRecord[] = []
  const resumes: ResumeRecord[] = []
  let totalEvents = 0
  let malformedLines = 0

  lines.forEach((raw, lineIndex) => {
    const trimmed = raw.trim()
    if (trimmed === "") return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      malformedLines += 1
      return
    }
    if (!isRecord(parsed)) {
      malformedLines += 1
      return
    }
    totalEvents += 1
    if (parsed.event === "decision") decisions.push(parseDecision(parsed, lineIndex))
    else if (parsed.event === "resume") resumes.push(parseResume(parsed, lineIndex))
  })

  return { totalEvents, malformedLines, decisions, resumes }
}

export function hasSignals(decision: DecisionRecord): boolean {
  return Object.keys(decision.signals).length > 0
}

export interface Distribution {
  count: number
  mean: number
  min: number
  max: number
  variance: number
}

export function signalDistributions(
  decisions: readonly DecisionRecord[],
): Record<RiskSignalName, Distribution> {
  const values = {} as Record<RiskSignalName, number[]>
  for (const name of RISK_SIGNAL_NAMES) values[name] = []
  for (const decision of decisions) {
    for (const name of RISK_SIGNAL_NAMES) {
      const entry = decision.signals[name]
      if (entry) values[name].push(entry.probability)
    }
  }
  const result = {} as Record<RiskSignalName, Distribution>
  for (const name of RISK_SIGNAL_NAMES) result[name] = statsFrom(values[name])
  return result
}

export interface NearThresholdEntry {
  signal: RiskSignalName
  probability: number
  threshold: "ask" | "block"
  thresholdValue: number
  distance: number
  outcome: EffectiveOutcome
  command: string
  sessionID: string
  reasonCode: string
  source: string
}

export function nearThresholdDecisions(
  decisions: readonly DecisionRecord[],
  thresholds: ThresholdMap,
  margin: number = DEFAULT_NEAR_MARGIN,
): NearThresholdEntry[] {
  const entries: NearThresholdEntry[] = []
  for (const decision of decisions) {
    for (const name of RISK_SIGNAL_NAMES) {
      const entry = decision.signals[name]
      if (!entry) continue
      const pair = thresholds[name]
      const askDistance = Math.abs(entry.probability - pair.ask)
      const blockDistance = Math.abs(entry.probability - pair.block)
      const nearest =
        askDistance <= blockDistance
          ? { threshold: "ask" as const, thresholdValue: pair.ask, distance: askDistance }
          : { threshold: "block" as const, thresholdValue: pair.block, distance: blockDistance }
      if (nearest.distance > margin) continue
      entries.push({
        signal: name,
        probability: entry.probability,
        threshold: nearest.threshold,
        thresholdValue: nearest.thresholdValue,
        distance: nearest.distance,
        outcome: decision.outcome,
        command: decision.command,
        sessionID: decision.sessionID,
        reasonCode: decision.reasonCode,
        source: decision.source,
      })
    }
  }
  return entries
}

export interface FlipCounts {
  allowToAsk: number
  allowToBlock: number
  askToAllow: number
  askToBlock: number
  blockToAllow: number
  blockToAsk: number
}

export interface FlipExample {
  command: string
  sessionID: string
  signal: RiskSignalName
  probability: number
  from: EffectiveOutcome
  to: EffectiveOutcome
}

export interface CandidateThresholdRow {
  signal: RiskSignalName
  field: "ask" | "block"
  value: number
  currentValue: number
  gridIndex: number
  flips: FlipCounts
  examples: FlipExample[]
}

export interface CandidateThresholdOptions {
  grid?: readonly number[]
  maxExamples?: number
}

export function candidateThresholds(
  decisions: readonly DecisionRecord[],
  thresholds: ThresholdMap,
  options: CandidateThresholdOptions = {},
): CandidateThresholdRow[] {
  const grid = options.grid ?? DEFAULT_THRESHOLD_GRID
  const maxExamples = options.maxExamples ?? 5
  const model = decisions.filter(hasSignals)
  const baseline = model.map((decision) => assessmentOutcome(decision, thresholds))
  const rows: CandidateThresholdRow[] = []

  for (const signal of RISK_SIGNAL_NAMES) {
    for (const field of ["ask", "block"] as const) {
      grid.forEach((value, gridIndex) => {
        const candidate = cloneThresholds(thresholds)
        const current = candidate[signal]
        candidate[signal] = field === "ask" ? { block: current.block, ask: value } : { block: value, ask: current.ask }
        const pair = candidate[signal]
        if (pair.ask > pair.block) return
        if (value === thresholds[signal][field]) return

        const flips = emptyFlips()
        const examples: FlipExample[] = []
        model.forEach((decision, index) => {
          const from = baseline[index] ?? "unknown"
          const to = assessmentOutcome(decision, candidate)
          if (from === to) return
          recordFlip(flips, from, to)
          if (examples.length < maxExamples) {
            examples.push({
              command: decision.command,
              sessionID: decision.sessionID,
              signal,
              probability: decision.signals[signal]?.probability ?? 0,
              from,
              to,
            })
          }
        })
        if (totalFlips(flips) === 0) return
        rows.push({ signal, field, value, currentValue: thresholds[signal][field], gridIndex, flips, examples })
      })
    }
  }
  return rows
}

export interface CandidateRange {
  signal: RiskSignalName
  field: "ask" | "block"
  from: number
  to: number
  flips: FlipCounts
  examples: FlipExample[]
}

export function groupCandidateRows(rows: readonly CandidateThresholdRow[]): CandidateRange[] {
  const ranges: CandidateRange[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    const previous = rows[index - 1]
    const last = ranges[ranges.length - 1]
    const merges =
      last !== undefined &&
      previous !== undefined &&
      last.signal === row.signal &&
      last.field === row.field &&
      flipsEqual(last.flips, row.flips) &&
      row.gridIndex === previous.gridIndex + 1
    if (merges && last) {
      last.to = row.value
      continue
    }
    ranges.push({
      signal: row.signal,
      field: row.field,
      from: row.value,
      to: row.value,
      flips: { ...row.flips },
      examples: [...row.examples],
    })
  }
  return ranges
}

export interface BlockedReviewEntry {
  command: string
  sessionID: string
  outcome: EffectiveOutcome
  reasonCode: string
  source: string
  timestamp?: string
  continued: boolean
  retried: boolean
}

export interface AllowedReviewEntry {
  command: string
  sessionID: string
  reasonCode: string
  source: string
  timestamp?: string
  followUpCommand: string
  followUpOutcome: EffectiveOutcome
  followUpSessionID: string
}

export interface ReviewQueues {
  blockedButBenign: BlockedReviewEntry[]
  dangerousButAllowed: AllowedReviewEntry[]
}

/**
 * Heuristic review queues grounded in the diagnostics event vocabulary:
 *  - blocked-but-benign: an ask/block decision whose session later accepted a
 *    resume (`resume` with `ok: true`) or retried the same command.
 *  - dangerous-but-allowed: an allow decision followed, in the same session, by
 *    a later ask/block decision.
 * Both are review queues, not verdicts; the follow-up evidence is weak and is
 * meant to be read next to the command text.
 */
export function reviewQueues(
  decisions: readonly DecisionRecord[],
  resumes: readonly ResumeRecord[],
): ReviewQueues {
  const decisionsBySession = new Map<string, DecisionRecord[]>()
  for (const decision of decisions) {
    const list = decisionsBySession.get(decision.sessionID) ?? []
    list.push(decision)
    decisionsBySession.set(decision.sessionID, list)
  }
  const resumesBySession = new Map<string, ResumeRecord[]>()
  for (const resume of resumes) {
    const list = resumesBySession.get(resume.sessionID) ?? []
    list.push(resume)
    resumesBySession.set(resume.sessionID, list)
  }

  const blockedButBenign: BlockedReviewEntry[] = []
  const dangerousButAllowed: AllowedReviewEntry[] = []

  for (const decision of decisions) {
    const later = (decisionsBySession.get(decision.sessionID) ?? []).filter(
      (candidate) => candidate.lineIndex > decision.lineIndex,
    )
    if (decision.outcome === "ask" || decision.outcome === "block") {
      const continued = (resumesBySession.get(decision.sessionID) ?? []).some(
        (resume) => resume.lineIndex > decision.lineIndex && resume.ok,
      )
      const retried = later.some((candidate) => candidate.command !== "" && candidate.command === decision.command)
      if (!continued && !retried) continue
      const entry: BlockedReviewEntry = {
        command: decision.command,
        sessionID: decision.sessionID,
        outcome: decision.outcome,
        reasonCode: decision.reasonCode,
        source: decision.source,
        continued,
        retried,
      }
      if (decision.timestamp !== undefined) entry.timestamp = decision.timestamp
      blockedButBenign.push(entry)
    } else if (decision.outcome === "allow") {
      const follow = later.find((candidate) => candidate.outcome === "ask" || candidate.outcome === "block")
      if (!follow) continue
      const entry: AllowedReviewEntry = {
        command: decision.command,
        sessionID: decision.sessionID,
        reasonCode: decision.reasonCode,
        source: decision.source,
        followUpCommand: follow.command,
        followUpOutcome: follow.outcome,
        followUpSessionID: follow.sessionID,
      }
      if (decision.timestamp !== undefined) entry.timestamp = decision.timestamp
      dangerousButAllowed.push(entry)
    }
  }

  return { blockedButBenign, dangerousButAllowed }
}

export interface CalibrationReport {
  totalEvents: number
  malformedLines: number
  decisionEvents: number
  modelReviewed: number
  resumeEvents: number
  thresholds: ThresholdMap
  margin: number
  distributions: Record<RiskSignalName, Distribution>
  nearThreshold: NearThresholdEntry[]
  candidates: CandidateRange[]
  blockedButBenign: BlockedReviewEntry[]
  dangerousButAllowed: AllowedReviewEntry[]
}

export interface CalibrationOptions {
  thresholds?: ThresholdMap
  margin?: number
  grid?: readonly number[]
  maxExamples?: number
}

export function analyzeCalibration(lines: readonly string[], options: CalibrationOptions = {}): CalibrationReport {
  const thresholds = options.thresholds ?? DEFAULT_SIGNAL_THRESHOLDS
  const margin = options.margin ?? DEFAULT_NEAR_MARGIN
  const parsed = parseCalibrationEvents(lines)
  const rows = candidateThresholds(parsed.decisions, thresholds, {
    ...(options.grid ? { grid: options.grid } : {}),
    ...(options.maxExamples !== undefined ? { maxExamples: options.maxExamples } : {}),
  })
  const { blockedButBenign, dangerousButAllowed } = reviewQueues(parsed.decisions, parsed.resumes)
  const modelReviewed = parsed.decisions.filter((decision) => !NON_MODEL_SOURCES.has(decision.source)).length

  return {
    totalEvents: parsed.totalEvents,
    malformedLines: parsed.malformedLines,
    decisionEvents: parsed.decisions.length,
    modelReviewed,
    resumeEvents: parsed.resumes.length,
    thresholds,
    margin,
    distributions: signalDistributions(parsed.decisions),
    nearThreshold: nearThresholdDecisions(parsed.decisions, thresholds, margin),
    candidates: groupCandidateRows(rows),
    blockedButBenign,
    dangerousButAllowed,
  }
}

export function formatCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = []
  lines.push("Calibration report")
  lines.push(
    `events: ${report.totalEvents} (decision ${report.decisionEvents}, model-reviewed ${report.modelReviewed}, resume ${report.resumeEvents})`,
  )
  lines.push(`malformed lines: ${report.malformedLines}`)
  lines.push(`near-threshold margin: ${report.margin}`)
  lines.push("")

  lines.push("Per-signal score distribution")
  for (const signal of RISK_SIGNAL_NAMES) {
    const stats = report.distributions[signal]
    lines.push(
      `  ${signal.padEnd(16)} count ${stats.count}  mean ${stats.mean.toFixed(3)}  min ${stats.min.toFixed(3)}  max ${stats.max.toFixed(3)}  var ${stats.variance.toFixed(4)}`,
    )
  }
  lines.push("")

  lines.push("Near-threshold decisions (nearest block/ask threshold within margin)")
  if (report.nearThreshold.length === 0) lines.push("  (none)")
  for (const entry of report.nearThreshold) {
    lines.push(
      `  ${entry.signal} p=${entry.probability.toFixed(2)} vs ${entry.threshold} ${entry.thresholdValue} (d=${entry.distance.toFixed(2)})  ${entry.outcome}  [${entry.source}]  ${truncate(entry.command)}`,
    )
  }
  lines.push("")

  lines.push("Candidate threshold table (which commands flip allow->ask / ask->block)")
  if (report.candidates.length === 0) lines.push("  (none)")
  for (const range of report.candidates) {
    const span = range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`
    lines.push(`  ${range.signal} ${range.field} = ${span}: ${formatFlips(range.flips)}`)
    for (const example of range.examples) {
      lines.push(`      ${example.from}->${example.to}  ${truncate(example.command)}`)
    }
  }
  lines.push("")

  lines.push("Blocked-but-benign review (ask/block decisions the session continued past)")
  if (report.blockedButBenign.length === 0) lines.push("  (none)")
  for (const entry of report.blockedButBenign) {
    const evidence = [entry.continued ? "continued" : "", entry.retried ? "retried" : ""].filter(Boolean).join("+")
    lines.push(`  [${entry.source}] ${entry.outcome} (${evidence})  ${truncate(entry.command)}`)
  }
  lines.push("")

  lines.push("Dangerous-but-allowed review (allow decisions followed by a flagged decision)")
  if (report.dangerousButAllowed.length === 0) lines.push("  (none)")
  for (const entry of report.dangerousButAllowed) {
    lines.push(
      `  allow ${truncate(entry.command)}  ->  ${entry.followUpOutcome} ${truncate(entry.followUpCommand)}`,
    )
  }
  lines.push("")

  lines.push("To apply overrides: edit signalThresholds in opencode.jsonc, validate the values, then restart opencode.")
  return lines.join("\n")
}

export type ThresholdValidation = { ok: true; thresholds: ThresholdMap } | { ok: false; error: string }

export function validateThresholdOverrides(value: unknown): ThresholdValidation {
  try {
    const config = parseConfig({ signalThresholds: value })
    return { ok: true, thresholds: config.signalThresholds }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function parseDecision(record: Record<string, unknown>, lineIndex: number): DecisionRecord {
  const decision = typeof record.decision === "string" ? record.decision : "unknown"
  const reasonCode = typeof record.reasonCode === "string" ? record.reasonCode : "unknown"
  const result: DecisionRecord = {
    lineIndex,
    sessionID: typeof record.sessionID === "string" ? record.sessionID : "unknown",
    action: typeof record.action === "string" ? record.action : "unknown",
    command: typeof record.command === "string" ? record.command : "",
    source: typeof record.source === "string" ? record.source : "unknown",
    decision,
    reasonCode,
    outcome: effectiveOutcome(decision, reasonCode),
    justified: record.justified === true,
    signals: parseSignals(record.signals),
    findings: parseFindings(record.findings),
  }
  if (typeof record.timestamp === "string") result.timestamp = record.timestamp
  if (typeof record.mode === "string") result.mode = record.mode
  if (typeof record.promptVersion === "string") result.promptVersion = record.promptVersion
  return result
}

function parseResume(record: Record<string, unknown>, lineIndex: number): ResumeRecord {
  const result: ResumeRecord = {
    lineIndex,
    sessionID: typeof record.sessionID === "string" ? record.sessionID : "unknown",
    ok: record.ok === true,
  }
  if (typeof record.started === "boolean") result.started = record.started
  if (typeof record.attempt === "number") result.attempt = record.attempt
  return result
}

function parseSignals(value: unknown): SignalMap {
  const signals: SignalMap = {}
  if (!isRecord(value)) return signals
  for (const name of SIGNAL_NAMES) {
    const entry = value[name]
    if (!isRecord(entry)) continue
    const probability = numeric(entry.probability)
    if (probability === undefined) continue
    signals[name] = { probability, confidence: numeric(entry.confidence) ?? 0 }
  }
  return signals
}

function parseFindings(value: unknown): DeterministicFinding[] {
  if (!Array.isArray(value)) return []
  const findings: DeterministicFinding[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    if (item.code !== "secret_exposure" && item.code !== "catastrophic_delete") continue
    findings.push({
      code: item.code,
      severity: item.severity === "hard" ? "hard" : "caution",
      message: typeof item.message === "string" ? item.message : "",
    })
  }
  return findings
}

function assessmentOutcome(decision: DecisionRecord, thresholds: ThresholdMap): EffectiveOutcome {
  const scores: SignalScores = { signals: buildFullSignals(decision.signals) }
  const assessment = assessSignals(scores, thresholds, decision.findings, { justification: decision.justified })
  return assessment.kind === "unjudged" ? "block" : assessment.kind
}

function buildFullSignals(signals: SignalMap): Record<SignalName, SignalEntry> {
  const full = {} as Record<SignalName, SignalEntry>
  for (const name of SIGNAL_NAMES) full[name] = signals[name] ?? { probability: 0, confidence: 0 }
  return full
}

function statsFrom(values: readonly number[]): Distribution {
  const count = values.length
  if (count === 0) return { count: 0, mean: 0, min: 0, max: 0, variance: 0 }
  let sum = 0
  let min = values[0]!
  let max = values[0]!
  for (const value of values) {
    sum += value
    if (value < min) min = value
    if (value > max) max = value
  }
  const mean = sum / count
  let acc = 0
  for (const value of values) acc += (value - mean) ** 2
  return { count, mean, min, max, variance: acc / count }
}

function cloneThresholds(thresholds: ThresholdMap): ThresholdMap {
  return Object.fromEntries(
    (Object.keys(thresholds) as RiskSignalName[]).map((key) => [key, { ...thresholds[key] }]),
  ) as ThresholdMap
}

function emptyFlips(): FlipCounts {
  return { allowToAsk: 0, allowToBlock: 0, askToAllow: 0, askToBlock: 0, blockToAllow: 0, blockToAsk: 0 }
}

function recordFlip(flips: FlipCounts, from: EffectiveOutcome, to: EffectiveOutcome): void {
  if (from === "allow" && to === "ask") flips.allowToAsk += 1
  else if (from === "allow" && to === "block") flips.allowToBlock += 1
  else if (from === "ask" && to === "allow") flips.askToAllow += 1
  else if (from === "ask" && to === "block") flips.askToBlock += 1
  else if (from === "block" && to === "allow") flips.blockToAllow += 1
  else if (from === "block" && to === "ask") flips.blockToAsk += 1
}

function totalFlips(flips: FlipCounts): number {
  return (
    flips.allowToAsk +
    flips.allowToBlock +
    flips.askToAllow +
    flips.askToBlock +
    flips.blockToAllow +
    flips.blockToAsk
  )
}

function flipsEqual(a: FlipCounts, b: FlipCounts): boolean {
  return (
    a.allowToAsk === b.allowToAsk &&
    a.allowToBlock === b.allowToBlock &&
    a.askToAllow === b.askToAllow &&
    a.askToBlock === b.askToBlock &&
    a.blockToAllow === b.blockToAllow &&
    a.blockToAsk === b.blockToAsk
  )
}

function formatFlips(flips: FlipCounts): string {
  const parts: string[] = []
  if (flips.allowToAsk) parts.push(`allow->ask ${flips.allowToAsk}`)
  if (flips.allowToBlock) parts.push(`allow->block ${flips.allowToBlock}`)
  if (flips.askToAllow) parts.push(`ask->allow ${flips.askToAllow}`)
  if (flips.askToBlock) parts.push(`ask->block ${flips.askToBlock}`)
  if (flips.blockToAllow) parts.push(`block->allow ${flips.blockToAllow}`)
  if (flips.blockToAsk) parts.push(`block->ask ${flips.blockToAsk}`)
  return parts.join(", ")
}

function truncate(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max) + "..." : text
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
