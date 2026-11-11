#!/usr/bin/env bun
/**
 * Level 1 — rater bench (no opencode).
 *
 * Calls `rateCommand` (src/risk-rater.ts) directly over the corpus in
 * benchmarks/corpus, N repeat-runs per scenario per model (default 5), and emits
 * per-signal score distributions, ROC-style separation margins between the
 * benign_looks_bad and clearly_bad masses, and threshold-sensitivity curves.
 *
 * Live-key gated exactly like test/risk-rater.integration.test.ts: without a key
 * it prints a skip notice and exits 0.
 *
 *   bun run benchmarks/rater-bench.ts
 *   bun run benchmarks/rater-bench.ts --models=jev-latest --repeats=5
 *
 * Output: benchmarks/results/rater-bench.json (full data) and
 * benchmarks/results/rater-bench.md (human-readable headline).
 */
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { rateCommand } from "../src/risk-rater.ts"
import { parseConfig } from "../src/config.ts"
import { SIGNAL_NAMES, type SignalName, type SignalScores } from "../src/types.ts"
import { loadCorpus, type CorpusEntry } from "./corpus-schema.ts"
import { assessOutcome, confusion, parseBenchArgs, type BenchOutcome, type ConfusionInput } from "./bench-core.ts"
import { separationMargin, summarize, sweepThresholds, type SeparationMargin, type Summary, type ThresholdPoint } from "./bench-stats.ts"

const CORPUS_DIR = join(import.meta.dir, "corpus")

const apiKey = process.env.TYPESAFE_API_KEY
const hasSystemOneKey = !!apiKey?.startsWith("apikey_")
const hasOpenAiKey = !!process.env.OPENAI_API_KEY

interface ScenarioResult {
  category: CorpusEntry["category"]
  expected: CorpusEntry["expected"]
  outcome: BenchOutcome
  errors: number
  perSignal: Record<SignalName, Summary>
  probabilities: Record<SignalName, number[]>
}

interface ModelReport {
  model: string
  calls: number
  errors: Array<{ id: string; repeat: number; message: string }>
  signalDistributions: Record<SignalName, Summary>
  scenarios: Record<string, ScenarioResult>
  separation: Record<SignalName, SeparationMargin>
  thresholdCurves: Record<SignalName, ThresholdPoint[]>
  confusion: ReturnType<typeof confusion>
}

function modalOutcome(outcomes: BenchOutcome[]): BenchOutcome {
  const counts = new Map<BenchOutcome, number>()
  for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
  let best: BenchOutcome = "unjudged"
  let bestCount = -1
  for (const [outcome, count] of counts) {
    if (count > bestCount) {
      best = outcome
      bestCount = count
    }
  }
  return best
}

function meanOf(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

async function benchModel(
  model: string,
  provider: string,
  entries: CorpusEntry[],
  repeats: number,
): Promise<ModelReport> {
  const config = parseConfig({
    provider,
    systemOneApiKey: apiKey,
    systemOneModel: model,
    openaiApiKey: process.env.OPENAI_API_KEY,
  })
  const report: ModelReport = {
    model,
    calls: 0,
    errors: [],
    signalDistributions: {} as Record<SignalName, Summary>,
    scenarios: {},
    separation: {} as Record<SignalName, SeparationMargin>,
    thresholdCurves: {} as Record<SignalName, ThresholdPoint[]>,
    confusion: confusion([]),
  }
  const allValues: Record<SignalName, number[]> = {} as Record<SignalName, number[]>
  for (const signal of SIGNAL_NAMES) allValues[signal] = []

  const confusionInputs: ConfusionInput[] = []

  for (const entry of entries) {
    const perSignalValues: Record<SignalName, number[]> = {} as Record<SignalName, number[]>
    for (const signal of SIGNAL_NAMES) perSignalValues[signal] = []
    const outcomes: BenchOutcome[] = []
    for (let repeat = 0; repeat < repeats; repeat++) {
      report.calls += 1
      let scores: SignalScores | undefined
      try {
        scores = await rateCommand(entry.command, entry.userContext, config, false)
      } catch (error) {
        report.errors.push({ id: entry.id, repeat, message: error instanceof Error ? error.message : String(error) })
        continue
      }
      outcomes.push(assessOutcome(scores))
      for (const signal of SIGNAL_NAMES) {
        const probability = scores.signals[signal].probability
        perSignalValues[signal].push(probability)
        allValues[signal].push(probability)
      }
    }
    const perSignal: Record<SignalName, Summary> = {} as Record<SignalName, Summary>
    for (const signal of SIGNAL_NAMES) perSignal[signal] = summarize(perSignalValues[signal])
    const outcome = modalOutcome(outcomes)
    report.scenarios[entry.id] = {
      category: entry.category,
      expected: entry.expected,
      outcome,
      errors: repeats - outcomes.length,
      perSignal,
      probabilities: perSignalValues,
    }
    confusionInputs.push({ expected: entry.expected, outcome })
  }

  for (const signal of SIGNAL_NAMES) {
    report.signalDistributions[signal] = summarize(allValues[signal])
  }

  const scenarioMeans = (category: CorpusEntry["category"]): Record<SignalName, number[]> => {
    const bySignal = {} as Record<SignalName, number[]>
    for (const signal of SIGNAL_NAMES) bySignal[signal] = []
    for (const entry of entries.filter((e) => e.category === category)) {
      const result = report.scenarios[entry.id]
      if (!result) continue
      for (const signal of SIGNAL_NAMES) bySignal[signal].push(meanOf(result.probabilities[signal]))
    }
    return bySignal
  }

  const benign = scenarioMeans("benign_looks_bad")
  const clearlyBad = scenarioMeans("clearly_bad")
  for (const signal of SIGNAL_NAMES) {
    report.separation[signal] = separationMargin(clearlyBad[signal], benign[signal])
    report.thresholdCurves[signal] = sweepThresholds(clearlyBad[signal], benign[signal])
  }

  report.confusion = confusion(confusionInputs)
  return report
}

function formatSignalTable(report: ModelReport, entries: CorpusEntry[]): string {
  const lines: string[] = []
  lines.push("| signal | mean | max | variance | stddev |")
  lines.push("| --- | --- | --- | --- | --- |")
  for (const signal of SIGNAL_NAMES) {
    const s = report.signalDistributions[signal]
    lines.push(`| ${signal} | ${s.mean.toFixed(3)} | ${s.max.toFixed(3)} | ${s.variance.toFixed(4)} | ${s.stddev.toFixed(3)} |`)
  }
  lines.push("")
  lines.push("| signal | AUC | margin | youden t | TPR | FPR |")
  lines.push("| --- | --- | --- | --- | --- | --- |")
  for (const signal of SIGNAL_NAMES) {
    const s = report.separation[signal]
    lines.push(`| ${signal} | ${s.auc.toFixed(3)} | ${s.margin.toFixed(3)} | ${s.threshold.toFixed(2)} | ${s.tpr.toFixed(2)} | ${s.fpr.toFixed(2)} |`)
  }
  lines.push("")
  const c = report.confusion
  lines.push(
    `Outcome confusion vs corpus expectation: ${c.agree}/${c.total} agree (accuracy ${(c.accuracy * 100).toFixed(1)}%); ` +
      `allow=${c.allow} ask=${c.ask} block=${c.block} unjudged=${c.unjudged}.`,
  )
  const mismatches = entries.filter((e) => report.scenarios[e.id] && report.scenarios[e.id].outcome !== e.expected)
  if (mismatches.length > 0) {
    lines.push("")
    lines.push("Mismatches (expected → observed):")
    for (const entry of mismatches) {
      lines.push(`- ${entry.id}: expected ${entry.expected}, got ${report.scenarios[entry.id].outcome} (${entry.category})`)
    }
  }
  return lines.join("\n")
}

function renderMarkdown(modelReports: ModelReport[], entries: CorpusEntry[], repeats: number): string {
  const byCategory = new Map<string, number>()
  for (const entry of entries) byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1)
  const lines: string[] = []
  lines.push("# Calibrated Access rater bench")
  lines.push("")
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Corpus: ${entries.length} scenarios (${[...byCategory].map(([k, v]) => `${k}=${v}`).join(", ")})`)
  lines.push(`Repeats per scenario per model: ${repeats}`)
  lines.push(`Models: ${modelReports.map((r) => r.model).join(", ")}`)
  lines.push("")
  for (const report of modelReports) {
    lines.push(`## Model: ${report.model}`)
    lines.push("")
    lines.push(`${report.calls} calls, ${report.errors.length} errors.`)
    lines.push("")
    lines.push(formatSignalTable(report, entries))
    lines.push("")
  }
  return lines.join("\n")
}

async function main(): Promise<void> {
  const options = parseBenchArgs(process.argv.slice(2))
  const keyPresent = options.provider === "openai-compatible" ? hasOpenAiKey : hasSystemOneKey
  if (!keyPresent) {
    console.warn(
      `Rater bench skipped: no live key for provider "${options.provider}" ` +
        `(${options.provider === "openai-compatible" ? "OPENAI_API_KEY" : "TYPESAFE_API_KEY"} not set or unexpected format).`,
    )
    return
  }

  const corpusDir = options.corpusDir === "benchmarks/corpus" ? CORPUS_DIR : options.corpusDir
  const entries = loadCorpus(corpusDir)
  console.log(`Rater bench: ${entries.length} scenarios, ${options.repeats} repeats, models=${options.models.join(",")}`)

  const reports: ModelReport[] = []
  for (const model of options.models) {
    console.log(`==> model ${model}`)
    const report = await benchModel(model, options.provider, entries, options.repeats)
    reports.push(report)
    console.log(`    ${report.calls} calls, ${report.errors.length} errors, accuracy ${(report.confusion.accuracy * 100).toFixed(1)}%`)
  }

  mkdirSync(options.outDir, { recursive: true })
  const payload = {
    generatedAt: new Date().toISOString(),
    repeats: options.repeats,
    provider: options.provider,
    corpus: {
      dir: options.corpusDir,
      total: entries.length,
      byCategory: Object.fromEntries(
        [...new Set(entries.map((e) => e.category))].map((category) => [
          category,
          entries.filter((e) => e.category === category).length,
        ]),
      ),
    },
    models: reports,
  }
  const jsonPath = join(options.outDir, "rater-bench.json")
  const mdPath = join(options.outDir, "rater-bench.md")
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n", "utf-8")
  writeFileSync(mdPath, renderMarkdown(reports, entries, options.repeats), "utf-8")
  console.log(`Wrote ${jsonPath}`)
  console.log(`Wrote ${mdPath}`)
}

await main()
