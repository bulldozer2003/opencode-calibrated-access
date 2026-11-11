import { describe, expect, test } from "bun:test"
import { JEV_INPUT_USD_PER_MILLION, summarizeDiagnostics, formatSummary } from "../src/diagnostics-sum.ts"

function line(event: Record<string, unknown>): string {
  return JSON.stringify(event)
}

const ts = (day: string) => `${day}T12:00:00.000Z`

describe("summarizeDiagnostics — empty & malformed", () => {
  test("returns zeros for empty input", () => {
    const s = summarizeDiagnostics([])
    expect(s.totalEvents).toBe(0)
    expect(s.decisionEvents).toBe(0)
    expect(s.modelReviewed).toBe(0)
    expect(s.inputTokens).toBe(0)
    expect(s.outputTokens).toBe(0)
    expect(s.measuredUSD).toBeNull()
    expect(s.estimatedUSD).toBe(0)
    expect(s.usd).toBe(0)
    expect(s.perDay).toEqual({})
    expect(s.perSession).toEqual({})
    expect(s.malformedLines).toBe(0)
  })

  test("skips malformed lines and blank lines with a warning count", () => {
    const lines = [
      line({ event: "decision", timestamp: ts("2026-11-01"), sessionID: "s1", source: "typesafe", usage: { input_tokens: 100, output_tokens: 10 } }),
      "{ not json",
      "",
      JSON.stringify([1, 2, 3]),
      "   ",
    ]
    const s = summarizeDiagnostics(lines)
    expect(s.totalEvents).toBe(1)
    expect(s.malformedLines).toBe(2)
    expect(s.inputTokens).toBe(100)
  })
})

describe("summarizeDiagnostics — token shapes", () => {
  test("sums System One input_tokens/output_tokens", () => {
    const lines = [
      line({ event: "decision", sessionID: "s1", source: "typesafe", usage: { input_tokens: 878, output_tokens: 125 } }),
      line({ event: "decision", sessionID: "s1", source: "typesafe", usage: { input_tokens: 100, output_tokens: 20 } }),
    ]
    const s = summarizeDiagnostics(lines)
    expect(s.inputTokens).toBe(978)
    expect(s.outputTokens).toBe(145)
  })

  test("sums OpenAI prompt_tokens/completion_tokens", () => {
    const lines = [
      line({ event: "decision", sessionID: "s1", source: "openai-compatible", usage: { prompt_tokens: 50, completion_tokens: 5 } }),
      line({ event: "decision", sessionID: "s1", source: "openai-compatible", usage: { prompt_tokens: 10, completion_tokens: 1 } }),
    ]
    const s = summarizeDiagnostics(lines)
    expect(s.inputTokens).toBe(60)
    expect(s.outputTokens).toBe(6)
  })

  test("prefers input_tokens over prompt_tokens and ignores non-numeric leaves", () => {
    const lines = [
      line({ event: "decision", sessionID: "s1", source: "typesafe", usage: { input_tokens: 200, prompt_tokens: 999, output_tokens: 20 } }),
      line({ event: "decision", sessionID: "s1", source: "typesafe", usage: { input_tokens: "300", output_tokens: null } }),
    ]
    const s = summarizeDiagnostics(lines)
    expect(s.inputTokens).toBe(200)
    expect(s.outputTokens).toBe(20)
  })

  test("tolerates missing usage entirely", () => {
    const s = summarizeDiagnostics([line({ event: "decision", sessionID: "s1", source: "typesafe" })])
    expect(s.inputTokens).toBe(0)
    expect(s.outputTokens).toBe(0)
  })
})

describe("summarizeDiagnostics — cost", () => {
  test("estimates USD at the published Jev input rate when cost is null", () => {
    const lines = [
      line({ event: "decision", sessionID: "s1", source: "typesafe", usage: { input_tokens: 1_000_000, output_tokens: 0 }, cost: null }),
    ]
    const s = summarizeDiagnostics(lines)
    expect(s.measuredUSD).toBeNull()
    expect(s.estimatedUSD).toBeCloseTo(JEV_INPUT_USD_PER_MILLION, 10)
    expect(s.usd).toBeCloseTo(JEV_INPUT_USD_PER_MILLION, 10)
    expect(s.usdEstimated).toBe(true)
  })

  test("sums measured cost.usd and cost.value leaves when present", () => {
    const lines = [
      line({ event: "decision", sessionID: "s1", source: "typesafe", usage: { input_tokens: 100 }, cost: { usd: 0.25 } }),
      line({ event: "decision", sessionID: "s1", source: "typesafe", usage: { input_tokens: 100 }, cost: { value: 0.1 } }),
    ]
    const s = summarizeDiagnostics(lines)
    expect(s.measuredUSD).toBeCloseTo(0.35, 10)
    expect(s.usd).toBeCloseTo(0.35, 10)
    expect(s.usdEstimated).toBe(false)
  })

  test("accepts a bare numeric cost", () => {
    const lines = [line({ event: "decision", sessionID: "s1", source: "typesafe", cost: 0.02 })]
    const s = summarizeDiagnostics(lines)
    expect(s.measuredUSD).toBeCloseTo(0.02, 10)
    expect(s.usdEstimated).toBe(false)
  })
})

describe("summarizeDiagnostics — model review & grouping", () => {
  test("counts model-reviewed decisions by source, excluding policy and session", () => {
    const lines = [
      line({ event: "decision", sessionID: "s1", source: "typesafe" }),
      line({ event: "decision", sessionID: "s1", source: "openai-compatible" }),
      line({ event: "decision", sessionID: "s1", source: "policy" }),
      line({ event: "decision", sessionID: "s1", source: "session" }),
      line({ event: "decision", sessionID: "s1", source: "error" }),
    ]
    const s = summarizeDiagnostics(lines)
    expect(s.decisionEvents).toBe(5)
    expect(s.modelReviewed).toBe(2)
  })

  test("groups decision counts per day and per session", () => {
    const lines = [
      line({ event: "decision", timestamp: ts("2026-11-01"), sessionID: "s1", source: "typesafe" }),
      line({ event: "decision", timestamp: ts("2026-11-01"), sessionID: "s1", source: "typesafe" }),
      line({ event: "decision", timestamp: ts("2026-11-02"), sessionID: "s2", source: "policy" }),
      line({ event: "request_received", timestamp: ts("2026-11-02"), sessionID: "s2" }),
    ]
    const s = summarizeDiagnostics(lines)
    expect(s.totalEvents).toBe(4)
    expect(s.perDay).toEqual({ "2026-11-01": 2, "2026-11-02": 1 })
    expect(s.perSession).toEqual({ s1: 2, s2: 1 })
  })
})

describe("summarizeDiagnostics — per-command-pattern score history", () => {
  test("computes mean, max and variance per signal per command pattern", () => {
    const lines = [
      line({ event: "decision", action: "bash", source: "typesafe", signals: { exfiltration: { probability: 0.2, confidence: 0.9 } } }),
      line({ event: "decision", action: "bash", source: "typesafe", signals: { exfiltration: { probability: 0.6, confidence: 0.9 } } }),
      line({ event: "decision", action: "bash", source: "typesafe", signals: { exfiltration: { probability: 0.4, confidence: 0.9 } } }),
    ]
    const s = summarizeDiagnostics(lines)
    const stats = s.perCommand["bash"]!.signals.exfiltration!
    expect(stats.count).toBe(3)
    expect(stats.mean).toBeCloseTo(0.4, 10)
    expect(stats.max).toBeCloseTo(0.6, 10)
    expect(stats.variance).toBeCloseTo(0.0266667, 6)
  })

  test("groups histories by command pattern and counts decision outcomes", () => {
    const lines = [
      line({ event: "decision", action: "bash", source: "typesafe", decision: "allow", signals: { exfiltration: { probability: 0.2 } } }),
      line({ event: "decision", action: "bash", source: "typesafe", decision: "deny", signals: { exfiltration: { probability: 0.6 } } }),
      line({ event: "decision", action: "external_directory", source: "typesafe", decision: "allow", signals: { exfiltration: { probability: 0.9 } } }),
    ]
    const s = summarizeDiagnostics(lines)
    expect(s.perCommand["bash"]!.count).toBe(2)
    expect(s.perCommand["bash"]!.outcomes).toEqual({ allow: 1, deny: 1 })
    expect(s.perCommand["external_directory"]!.count).toBe(1)
    expect(s.perCommand["bash"]!.signals.exfiltration!.mean).toBeCloseTo(0.4, 10)
    expect(s.perCommand["external_directory"]!.signals.exfiltration!.mean).toBeCloseTo(0.9, 10)
  })

  test("counts events without signal data but excludes them from signal stats", () => {
    const lines = [
      line({ event: "decision", action: "bash", source: "typesafe", decision: "allow", signals: { exfiltration: { probability: 0.2 } } }),
      line({ event: "decision", action: "bash", source: "typesafe", decision: "allow" }),
      line({ event: "decision", action: "bash", source: "policy", decision: "deny" }),
      line({ event: "decision", action: "bash", source: "typesafe", decision: "allow", signals: null }),
    ]
    const s = summarizeDiagnostics(lines)
    expect(s.perCommand["bash"]!.count).toBe(4)
    expect(s.perCommand["bash"]!.outcomes).toEqual({ allow: 3, deny: 1 })
    expect(s.perCommand["bash"]!.signals.exfiltration!.count).toBe(1)
    expect(s.perCommand["bash"]!.signals.exfiltration!.mean).toBeCloseTo(0.2, 10)
  })

  test("tolerates partial signal maps and non-numeric probabilities", () => {
    const lines = [
      line({ event: "decision", action: "bash", source: "typesafe", signals: { exfiltration: { probability: 0.2 } } }),
      line({ event: "decision", action: "bash", source: "typesafe", signals: { destructive: { probability: 0.5 } } }),
      line({ event: "decision", action: "bash", source: "typesafe", signals: { exfiltration: { probability: "0.6" } } }),
      line({ event: "decision", action: "bash", source: "typesafe", signals: { exfiltration: { confidence: 0.9 } } }),
    ]
    const s = summarizeDiagnostics(lines)
    expect(s.perCommand["bash"]!.count).toBe(4)
    expect(s.perCommand["bash"]!.signals.exfiltration!.count).toBe(1)
    expect(s.perCommand["bash"]!.signals.exfiltration!.mean).toBeCloseTo(0.2, 10)
    expect(s.perCommand["bash"]!.signals.destructive!.count).toBe(1)
    expect(s.perCommand["bash"]!.signals.destructive!.mean).toBeCloseTo(0.5, 10)
  })
})

describe("formatSummary", () => {
  test("renders the headline sums", () => {
    const s = summarizeDiagnostics([
      line({ event: "decision", timestamp: ts("2026-11-01"), sessionID: "s1", source: "typesafe", usage: { input_tokens: 1_000_000, output_tokens: 125 }, cost: null }),
    ])
    const text = formatSummary(s)
    expect(text).toContain("decision events:")
    expect(text).toContain("input tokens: 1000000")
    expect(text).toContain("output tokens: 125")
    expect(text).toContain("estimated")
  })

  test("renders per-command-pattern signal history", () => {
    const s = summarizeDiagnostics([
      line({ event: "decision", action: "bash", source: "typesafe", signals: { exfiltration: { probability: 0.2 } } }),
      line({ event: "decision", action: "bash", source: "typesafe", signals: { exfiltration: { probability: 0.6 } } }),
    ])
    const text = formatSummary(s)
    expect(text).toContain("Per command pattern")
    expect(text).toContain("bash")
    expect(text).toContain("exfiltration")
    expect(text).toContain("mean 0.400")
  })
})
