import { SIGNAL_NAMES, type SignalName } from "./types.ts"

export const JEV_INPUT_USD_PER_MILLION = 0.042

export interface SignalStats {
  count: number
  mean: number
  max: number
  variance: number
}

export interface CommandPatternStats {
  count: number
  outcomes: Record<string, number>
  signals: Record<string, SignalStats>
}

export interface DiagnosticSummary {
  totalEvents: number
  decisionEvents: number
  modelReviewed: number
  inputTokens: number
  outputTokens: number
  measuredUSD: number | null
  estimatedUSD: number
  usd: number
  usdEstimated: boolean
  perDay: Record<string, number>
  perSession: Record<string, number>
  perCommand: Record<string, CommandPatternStats>
  malformedLines: number
}

const NON_MODEL_SOURCES = new Set(["policy", "session", "error"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numericLeaf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function tokenCount(usage: Record<string, unknown>, primary: string, secondary: string): number {
  return numericLeaf(usage[primary]) ?? numericLeaf(usage[secondary]) ?? 0
}

function costUSD(cost: unknown): number | undefined {
  const direct = numericLeaf(cost)
  if (direct !== undefined) return direct
  if (!isRecord(cost)) return undefined
  return numericLeaf(cost.usd) ?? numericLeaf(cost.value)
}

function statsFrom(values: readonly number[]): SignalStats {
  const count = values.length
  if (count === 0) return { count: 0, mean: 0, max: 0, variance: 0 }
  let total = 0
  let max = 0
  for (const value of values) {
    total += value
    if (value > max) max = value
  }
  const mean = total / count
  let acc = 0
  for (const value of values) acc += (value - mean) ** 2
  return { count, mean, max, variance: acc / count }
}

export function summarizeDiagnostics(lines: readonly string[]): DiagnosticSummary {
  let totalEvents = 0
  let decisionEvents = 0
  let modelReviewed = 0
  let inputTokens = 0
  let outputTokens = 0
  let measuredUSD = 0
  let measuredAny = false
  let malformedLines = 0
  const perDay: Record<string, number> = {}
  const perSession: Record<string, number> = {}
  const perCommand: Record<string, { outcomes: Record<string, number>; count: number; signals: Record<string, number[]> }> = {}

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed === "") continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      malformedLines += 1
      continue
    }
    if (!isRecord(parsed)) {
      malformedLines += 1
      continue
    }
    totalEvents += 1

    if (isRecord(parsed.usage)) {
      inputTokens += tokenCount(parsed.usage, "input_tokens", "prompt_tokens")
      outputTokens += tokenCount(parsed.usage, "output_tokens", "completion_tokens")
    }

    const cost = costUSD(parsed.cost)
    if (cost !== undefined) {
      measuredUSD += cost
      measuredAny = true
    }

    if (parsed.event === "decision") {
      decisionEvents += 1
      const source = typeof parsed.source === "string" ? parsed.source : ""
      if (!NON_MODEL_SOURCES.has(source)) modelReviewed += 1
      const day = typeof parsed.timestamp === "string" ? parsed.timestamp.slice(0, 10) : "unknown"
      perDay[day] = (perDay[day] ?? 0) + 1
      const session = typeof parsed.sessionID === "string" ? parsed.sessionID : "unknown"
      perSession[session] = (perSession[session] ?? 0) + 1

      const command = typeof parsed.action === "string" ? parsed.action : "unknown"
      const bucket = (perCommand[command] ??= { count: 0, outcomes: {}, signals: {} })
      bucket.count += 1
      const outcome = typeof parsed.decision === "string" ? parsed.decision : "unknown"
      bucket.outcomes[outcome] = (bucket.outcomes[outcome] ?? 0) + 1
      if (isRecord(parsed.signals)) {
        for (const signal of SIGNAL_NAMES) {
          const entry = parsed.signals[signal]
          if (!isRecord(entry)) continue
          const probability = numericLeaf(entry.probability)
          if (probability === undefined) continue
          ;(bucket.signals[signal] ??= []).push(probability)
        }
      }
    }
  }

  const estimatedUSD = (inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MILLION
  const usdEstimated = !measuredAny
  const usd = usdEstimated ? estimatedUSD : measuredUSD

  const commandStats: Record<string, CommandPatternStats> = {}
  for (const [command, bucket] of Object.entries(perCommand)) {
    const signals: Record<string, SignalStats> = {}
    for (const [signal, values] of Object.entries(bucket.signals)) signals[signal] = statsFrom(values)
    commandStats[command] = { count: bucket.count, outcomes: bucket.outcomes, signals }
  }

  return {
    totalEvents,
    decisionEvents,
    modelReviewed,
    inputTokens,
    outputTokens,
    measuredUSD: measuredAny ? measuredUSD : null,
    estimatedUSD,
    usd,
    usdEstimated,
    perDay,
    perSession,
    perCommand: commandStats,
    malformedLines,
  }
}

function groupLines(group: Record<string, number>): string {
  const entries = Object.entries(group)
  if (entries.length === 0) return "  (none)"
  return entries.map(([key, count]) => `  ${key}  ${count}`).join("\n")
}

function commandLines(perCommand: Record<string, CommandPatternStats>): string {
  const entries = Object.entries(perCommand)
  if (entries.length === 0) return "  (none)"
  const lines: string[] = []
  for (const [command, stats] of entries) {
    const outcomes = Object.entries(stats.outcomes)
      .map(([outcome, count]) => `${outcome}=${count}`)
      .join(" ")
    lines.push(`  ${command}  events ${stats.count}${outcomes ? `  (${outcomes})` : ""}`)
    const signals = Object.entries(stats.signals)
    if (signals.length === 0) {
      lines.push("    (no signal data)")
      continue
    }
    for (const [signal, signalStats] of signals) {
      lines.push(
        `    ${signal}  count ${signalStats.count} mean ${signalStats.mean.toFixed(3)} max ${signalStats.max.toFixed(3)} var ${signalStats.variance.toFixed(4)}`,
      )
    }
  }
  return lines.join("\n")
}

export function formatSummary(summary: DiagnosticSummary): string {
  const costLine = summary.usdEstimated
    ? `est. USD: $${summary.usd.toFixed(6)} (estimated at $${JEV_INPUT_USD_PER_MILLION}/M input)`
    : `USD: $${summary.usd.toFixed(6)} (measured)`
  return [
    "Diagnostics summary",
    `total events: ${summary.totalEvents}`,
    `decision events: ${summary.decisionEvents} (model-reviewed: ${summary.modelReviewed})`,
    `input tokens: ${summary.inputTokens}`,
    `output tokens: ${summary.outputTokens}`,
    costLine,
    `malformed lines: ${summary.malformedLines}`,
    "",
    "Per day:",
    groupLines(summary.perDay),
    "",
    "Per session:",
    groupLines(summary.perSession),
    "",
    "Per command pattern:",
    commandLines(summary.perCommand),
  ].join("\n")
}
