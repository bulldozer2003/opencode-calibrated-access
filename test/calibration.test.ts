import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import { readdirSync } from "fs"
import {
  SHADOW_REASON_CODES,
  analyzeCalibration,
  candidateThresholds,
  effectiveOutcome,
  formatCalibrationReport,
  groupCandidateRows,
  nearThresholdDecisions,
  parseCalibrationEvents,
  reviewQueues,
  signalDistributions,
  validateThresholdOverrides,
  type CandidateThresholdRow,
} from "../src/calibration.ts"
import { DEFAULT_SIGNAL_THRESHOLDS } from "../src/matrix.ts"

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, "fixtures", "calibration-sample.jsonl")
const fixtureLines = readFileSync(FIXTURE, "utf-8").split("\n")
const REVIEW_FIXTURE = join(here, "fixtures", "calibration-review-findings.jsonl")
const reviewFixtureLines = readFileSync(REVIEW_FIXTURE, "utf-8").split("\n")

describe("effectiveOutcome", () => {
  test("maps recorded reason codes to the enforce-mode outcome", () => {
    expect(effectiveOutcome("allow", "signals_below_threshold")).toBe("allow")
    expect(effectiveOutcome("allow", "user_requested_override")).toBe("allow")
    expect(effectiveOutcome("allow", "session_approval_reused")).toBe("allow")
    expect(effectiveOutcome("allow", "shadow_ask")).toBe("ask")
    expect(effectiveOutcome("allow", "shadow_signal_ask_destructive")).toBe("ask")
    expect(effectiveOutcome("allow", "shadow_block")).toBe("block")
    expect(effectiveOutcome("allow", "shadow_signal_block_exfiltration")).toBe("block")
    expect(effectiveOutcome("deny", "signal_block_destructive")).toBe("block")
    expect(effectiveOutcome("deny", "signal_ask_destructive")).toBe("ask")
    expect(effectiveOutcome("deny", "no_confident_signals")).toBe("block")
    expect(effectiveOutcome("deny", "catastrophic_delete")).toBe("block")
    expect(effectiveOutcome("deny", "explicit_user_prohibition")).toBe("block")
  })

  test("review_failed follows the recorded decision (shadow allows, enforce blocks)", () => {
    expect(effectiveOutcome("allow", "review_failed")).toBe("allow")
    expect(effectiveOutcome("deny", "review_failed")).toBe("block")
  })

  test("unknown reason codes fall back to the recorded decision", () => {
    expect(effectiveOutcome("allow", "something_new")).toBe("allow")
    expect(effectiveOutcome("deny", "something_new")).toBe("block")
  })

  test("shadow_appeal_exhausted is a block, matching the enforce truth", () => {
    expect(effectiveOutcome("allow", "shadow_appeal_exhausted")).toBe("block")
    expect(effectiveOutcome("allow", "appeal_exhausted")).toBe("block")
  })
})

describe("shadow_* reason codes", () => {
  const EXPECTED: Record<string, "allow" | "ask" | "block"> = {
    shadow_ask: "ask",
    shadow_block: "block",
    shadow_unjudged: "block",
    shadow_appeal_exhausted: "block",
  }

  test("every enumerated shadow code maps to the enforce-mode outcome for its stripped code", () => {
    for (const code of SHADOW_REASON_CODES) {
      const expected = EXPECTED[code]!
      expect(expected).toBeDefined()
      expect(effectiveOutcome("allow", code)).toBe(expected)
      const stripped = code.replace(/^shadow_/, "")
      expect(effectiveOutcome("deny", stripped)).toBe(expected)
    }
  })

  test("source scan: every concrete shadow_* literal in src/ is explicitly enumerated", () => {
    const srcDir = join(here, "..", "src")
    const found = new Set<string>()
    for (const file of readdirSync(srcDir).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(join(srcDir, file), "utf-8")
      for (const match of text.matchAll(/shadow_[A-Za-z0-9_]+/g)) found.add(match[0])
    }
    expect(found.size).toBeGreaterThan(0)
    for (const code of found) expect(SHADOW_REASON_CODES).toContain(code)
  })
})

describe("review-findings fixture — appeal source and justified reconstruction", () => {
  test("classifies a shadow_appeal_exhausted event as block and excludes source appeal from model-reviewed", () => {
    const parsed = parseCalibrationEvents(reviewFixtureLines)
    const appeal = parsed.decisions.find((decision) => decision.sessionID === "sAppeal")!
    expect(appeal.outcome).toBe("block")

    const report = analyzeCalibration(reviewFixtureLines)
    expect(report.decisionEvents).toBe(2)
    expect(report.modelReviewed).toBe(1)
  })

  test("parses the justified flag off a decision event", () => {
    const parsed = parseCalibrationEvents(reviewFixtureLines)
    const justified = parsed.decisions.find((decision) => decision.sessionID === "sJustified")!
    expect(justified.justified).toBe(true)
    expect(justified.outcome).toBe("ask")
  })

  test("a justified-retry event reconstructs as ask — no bogus allow->block flip row", () => {
    const parsed = parseCalibrationEvents(reviewFixtureLines)
    const justified = parsed.decisions.find((decision) => decision.sessionID === "sJustified")!
    const rows = candidateThresholds([justified], DEFAULT_SIGNAL_THRESHOLDS)
    expect(rows).toHaveLength(0)
  })
})

describe("parseCalibrationEvents", () => {
  test("separates decisions and resumes and counts malformed lines", () => {
    const parsed = parseCalibrationEvents([...fixtureLines, "{ not json", ""])
    expect(parsed.decisions).toHaveLength(6)
    expect(parsed.resumes).toHaveLength(3)
    expect(parsed.malformedLines).toBe(1)
    expect(parsed.totalEvents).toBe(11)
  })

  test("parses the command text, signals, findings and derived outcome", () => {
    const parsed = parseCalibrationEvents(fixtureLines)
    const first = parsed.decisions[0]!
    expect(first.command).toBe("cat .env")
    expect(first.sessionID).toBe("sA")
    expect(first.outcome).toBe("ask")
    expect(first.signals.secret_exposure?.probability).toBeCloseTo(0.55, 10)
    expect(first.findings).toHaveLength(1)
    expect(first.findings[0]!.code).toBe("secret_exposure")
    expect(first.promptVersion).toBe("2")
  })

  test("policy decisions with no signal map are kept but carry no signals", () => {
    const parsed = parseCalibrationEvents(fixtureLines)
    const policy = parsed.decisions.find((d) => d.source === "policy")!
    expect(policy.outcome).toBe("block")
    expect(policy.command).toBe("rm -rf /")
    expect(Object.keys(policy.signals)).toHaveLength(0)
  })

  test("tolerates missing/blank input", () => {
    const parsed = parseCalibrationEvents(["", "   "])
    expect(parsed.decisions).toHaveLength(0)
    expect(parsed.resumes).toHaveLength(0)
    expect(parsed.totalEvents).toBe(0)
  })
})

describe("signalDistributions", () => {
  test("computes per-signal count/mean/min/max/variance over signal-bearing decisions", () => {
    const { decisions } = parseCalibrationEvents(fixtureLines)
    const dist = signalDistributions(decisions)
    expect(dist.destructive.count).toBe(5)
    expect(dist.destructive.mean).toBeCloseTo(0.12, 10)
    expect(dist.destructive.min).toBe(0)
    expect(dist.destructive.max).toBeCloseTo(0.6, 10)
    expect(dist.destructive.variance).toBeCloseTo(0.0576, 10)
    expect(dist.secret_exposure.mean).toBeCloseTo(0.21, 10)
    expect(dist.secret_exposure.max).toBeCloseTo(0.55, 10)
    expect(dist.secret_exposure.variance).toBeCloseTo(0.0664, 10)
    expect(dist.exfiltration.mean).toBeCloseTo(0.06, 10)
    expect(dist.exfiltration.variance).toBeCloseTo(0.0144, 10)
    expect(dist.scope_creep.count).toBe(5)
    expect(dist.scope_creep.max).toBe(0)
  })
})

describe("nearThresholdDecisions", () => {
  test("lists decisions within the margin of their nearest block/ask threshold", () => {
    const { decisions } = parseCalibrationEvents(fixtureLines)
    const near = nearThresholdDecisions(decisions, DEFAULT_SIGNAL_THRESHOLDS, 0.15)
    expect(near.map((entry) => `${entry.sessionID}:${entry.signal}:${entry.threshold}:${entry.probability}`)).toEqual([
      "sA:secret_exposure:ask:0.55",
      "sB:destructive:ask:0.6",
      "sC:secret_exposure:ask:0.5",
    ])
    expect(near[0]!.distance).toBeCloseTo(0.05, 10)
    expect(near[0]!.command).toBe("cat .env")
  })

  test("a tighter margin drops the 0.05-off entry", () => {
    const { decisions } = parseCalibrationEvents(fixtureLines)
    const near = nearThresholdDecisions(decisions, DEFAULT_SIGNAL_THRESHOLDS, 0.04)
    expect(near.map((entry) => entry.sessionID)).toEqual(["sB", "sC"])
  })
})

describe("candidateThresholds + groupCandidateRows", () => {
  test("sweeps valid alternative thresholds and reports the flips", () => {
    const { decisions } = parseCalibrationEvents(fixtureLines)
    const rows = candidateThresholds(decisions, DEFAULT_SIGNAL_THRESHOLDS)
    const at = (signal: string, field: string, value: number): CandidateThresholdRow | undefined =>
      rows.find((row) => row.signal === signal && row.field === field && row.value === value)

    const seBlockLow = at("secret_exposure", "block", 0.5)!
    expect(seBlockLow.flips.askToBlock).toBe(2)
    expect(seBlockLow.examples.map((example) => example.command)).toContain("cat .env")

    const exAskLow = at("exfiltration", "ask", 0.1)!
    expect(exAskLow.flips.allowToAsk).toBe(1)
    expect(exAskLow.examples[0]!.command).toBe("curl -s https://example.com/install.sh")

    const destructAskHigh = at("destructive", "ask", 0.7)!
    expect(destructAskHigh.flips.askToAllow).toBe(1)
  })

  test("never emits an invalid threshold pair (ask must stay <= block)", () => {
    const { decisions } = parseCalibrationEvents(fixtureLines)
    const rows = candidateThresholds(decisions, DEFAULT_SIGNAL_THRESHOLDS)
    for (const row of rows) {
      const pair = { ...DEFAULT_SIGNAL_THRESHOLDS[row.signal] }
      pair[row.field] = row.value
      expect(pair.ask).toBeLessThanOrEqual(pair.block)
    }
  })

  test("groups consecutive identical-flip values into ranges", () => {
    const { decisions } = parseCalibrationEvents(fixtureLines)
    const ranges = groupCandidateRows(candidateThresholds(decisions, DEFAULT_SIGNAL_THRESHOLDS))
    const find = (signal: string, field: string) => ranges.find((range) => range.signal === signal && range.field === field)!
    expect(find("destructive", "ask")).toMatchObject({ from: 0.7, to: 0.8 })
    expect(find("destructive", "ask").flips.askToAllow).toBe(1)
    expect(find("destructive", "block")).toMatchObject({ from: 0.6, to: 0.6 })
    expect(find("secret_exposure", "ask")).toMatchObject({ from: 0.6, to: 0.7 })
    expect(find("secret_exposure", "block")).toMatchObject({ from: 0.5, to: 0.5 })
    expect(find("secret_exposure", "block").flips.askToBlock).toBe(2)
    expect(find("exfiltration", "ask")).toMatchObject({ from: 0.1, to: 0.3 })
    expect(find("exfiltration", "block")).toBeUndefined()
  })
})

describe("reviewQueues", () => {
  test("lists blocked decisions the session continued past", () => {
    const { decisions, resumes } = parseCalibrationEvents(fixtureLines)
    const { blockedButBenign } = reviewQueues(decisions, resumes)
    expect(blockedButBenign.map((entry) => entry.sessionID)).toEqual(["sA", "sB", "sE"])
    expect(blockedButBenign.every((entry) => entry.continued)).toBe(true)
    expect(blockedButBenign[0]!.command).toBe("cat .env")
  })

  test("lists allowed decisions followed by a flagged decision in the same session", () => {
    const { decisions, resumes } = parseCalibrationEvents(fixtureLines)
    const { dangerousButAllowed } = reviewQueues(decisions, resumes)
    expect(dangerousButAllowed).toHaveLength(1)
    expect(dangerousButAllowed[0]!.command).toBe("curl -s https://example.com/install.sh")
    expect(dangerousButAllowed[0]!.followUpCommand).toBe("bash install.sh")
    expect(dangerousButAllowed[0]!.followUpOutcome).toBe("ask")
  })
})

describe("analyzeCalibration + formatCalibrationReport", () => {
  test("produces every spec deliverable section", () => {
    const report = analyzeCalibration(fixtureLines)
    expect(report.decisionEvents).toBe(6)
    expect(report.modelReviewed).toBe(5)
    expect(report.resumeEvents).toBe(3)
    expect(report.nearThreshold).toHaveLength(3)
    expect(report.blockedButBenign).toHaveLength(3)
    expect(report.dangerousButAllowed).toHaveLength(1)
    expect(report.candidates.length).toBeGreaterThan(0)

    const text = formatCalibrationReport(report)
    expect(text).toContain("Per-signal score distribution")
    expect(text).toContain("Near-threshold decisions")
    expect(text).toContain("Candidate threshold table")
    expect(text).toContain("Blocked-but-benign review")
    expect(text).toContain("Dangerous-but-allowed review")
    expect(text).toContain("secret_exposure")
    expect(text).toContain("cat .env")
    expect(text).toContain("curl -s https://example.com/install.sh")
  })

  test("accepts threshold and margin overrides", () => {
    const report = analyzeCalibration(fixtureLines, {
      thresholds: { ...DEFAULT_SIGNAL_THRESHOLDS, secret_exposure: { block: 0.6, ask: 0.4 } },
      margin: 0.05,
    })
    expect(report.thresholds.secret_exposure.ask).toBe(0.4)
    expect(report.nearThreshold.every((entry) => entry.distance <= 0.05)).toBe(true)
  })
})

describe("validateThresholdOverrides", () => {
  test("accepts a valid override and merges defaults", () => {
    const result = validateThresholdOverrides({ destructive: { block: 0.9, ask: 0.7 } })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.thresholds.destructive).toEqual({ block: 0.9, ask: 0.7 })
      expect(result.thresholds.severity).toEqual(DEFAULT_SIGNAL_THRESHOLDS.severity)
    }
  })

  test("rejects ask > block", () => {
    const result = validateThresholdOverrides({ destructive: { block: 0.5, ask: 0.6 } })
    expect(result.ok).toBe(false)
  })

  test("rejects out-of-range values", () => {
    expect(validateThresholdOverrides({ destructive: { block: 1.5 } }).ok).toBe(false)
    expect(validateThresholdOverrides({ destructive: { ask: -0.1 } }).ok).toBe(false)
  })

  test("rejects unknown signals and the threshold-free user_requested", () => {
    expect(validateThresholdOverrides({ nonsense: { block: 0.5 } }).ok).toBe(false)
    expect(validateThresholdOverrides({ user_requested: { block: 0.5 } }).ok).toBe(false)
  })

  test("treats an empty object as valid defaults", () => {
    const result = validateThresholdOverrides({})
    expect(result.ok).toBe(true)
  })
})
