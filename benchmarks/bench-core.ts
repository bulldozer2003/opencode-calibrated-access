import { assessSignals, DEFAULT_SIGNAL_THRESHOLDS } from "../src/matrix.ts"
import type { DeterministicFinding, SignalScores } from "../src/types.ts"

export interface BenchOptions {
  models: string[]
  repeats: number
  corpusDir: string
  outDir: string
  provider: string
  findings: "raw" | "enabled"
}

export const BENCH_DEFAULTS = {
  models: ["jev-latest"],
  repeats: 5,
  corpusDir: "benchmarks/corpus",
  outDir: "benchmarks/results",
  provider: "typesafe",
  findings: "raw" as "raw" | "enabled",
}

/**
 * Parse `--flag=value` bench arguments. Unknown flags and positional tokens are
 * ignored so the script stays forward-compatible. `--repeats` must be a
 * positive integer; anything else throws.
 */
export function parseBenchArgs(argv: string[]): BenchOptions {
  const options: BenchOptions = {
    models: [...BENCH_DEFAULTS.models],
    repeats: BENCH_DEFAULTS.repeats,
    corpusDir: BENCH_DEFAULTS.corpusDir,
    outDir: BENCH_DEFAULTS.outDir,
    provider: BENCH_DEFAULTS.provider,
    findings: BENCH_DEFAULTS.findings,
  }
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue
    const eq = arg.indexOf("=")
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    const value = eq === -1 ? "" : arg.slice(eq + 1)
    switch (key) {
      case "models": {
        const models = value
          .split(",")
          .map((m) => m.trim())
          .filter((m) => m.length > 0)
        if (models.length > 0) options.models = models
        break
      }
      case "repeats": {
        const repeats = Number(value)
        if (!Number.isInteger(repeats) || repeats <= 0) {
          throw new Error(`--repeats must be a positive integer, got "${value}"`)
        }
        options.repeats = repeats
        break
      }
      case "corpus":
        if (value) options.corpusDir = value
        break
      case "out":
        if (value) options.outDir = value
        break
      case "provider":
        if (value) options.provider = value
        break
      case "findings":
        if (value === "raw" || value === "enabled") options.findings = value
        else if (value) throw new Error(`--findings must be "raw" or "enabled", got "${value}"`)
        break
      default:
        break
    }
  }
  return options
}

export type BenchOutcome = "allow" | "ask" | "block" | "unjudged"

/** Classify one rating through the real signal matrix (default thresholds). */
export function assessOutcome(scores: SignalScores, findings: DeterministicFinding[] = []): BenchOutcome {
  return assessSignals(scores, DEFAULT_SIGNAL_THRESHOLDS, findings).kind
}

export interface Confusion {
  total: number
  allow: number
  ask: number
  block: number
  unjudged: number
  agree: number
  accuracy: number
}

export interface ConfusionInput {
  expected: BenchOutcome
  outcome: BenchOutcome
}

/**
 * Tally observed outcomes and the rate at which they match the corpus's
 * expected outcome. `accuracy` is agreement / total (0 when empty).
 */
export function confusion(entries: ConfusionInput[]): Confusion {
  const result: Confusion = { total: 0, allow: 0, ask: 0, block: 0, unjudged: 0, agree: 0, accuracy: 0 }
  for (const entry of entries) {
    result.total += 1
    result[entry.outcome] += 1
    if (entry.outcome === entry.expected) result.agree += 1
  }
  result.accuracy = result.total === 0 ? 0 : result.agree / result.total
  return result
}
