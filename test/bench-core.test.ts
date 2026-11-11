import { describe, expect, test } from "bun:test"
import { assessOutcome, confusion, parseBenchArgs } from "../benchmarks/bench-core.ts"
import { SIGNAL_NAMES, type SignalName, type SignalScores } from "../src/types.ts"

function scores(overrides: Partial<Record<SignalName, number>> = {}, confidence = 0.9): SignalScores {
  const signals = {} as SignalScores["signals"]
  for (const name of SIGNAL_NAMES) {
    signals[name] = { probability: overrides[name] ?? 0.05, confidence }
  }
  return { signals }
}

describe("bench-core parseBenchArgs", () => {
  test("defaults: jev-latest, 5 repeats, repo corpus/results", () => {
    const opts = parseBenchArgs([])
    expect(opts.models).toEqual(["jev-latest"])
    expect(opts.repeats).toBe(5)
    expect(opts.corpusDir).toBe("benchmarks/corpus")
    expect(opts.outDir).toBe("benchmarks/results")
    expect(opts.provider).toBe("typesafe")
  })

  test("parses a comma-separated model matrix", () => {
    expect(parseBenchArgs(["--models=jev-latest,jev-small"]).models).toEqual(["jev-latest", "jev-small"])
  })

  test("parses repeats and provider", () => {
    const opts = parseBenchArgs(["--repeats=3", "--provider=openai-compatible"])
    expect(opts.repeats).toBe(3)
    expect(opts.provider).toBe("openai-compatible")
  })

  test("parses corpus and out dirs", () => {
    const opts = parseBenchArgs(["--corpus=/tmp/c", "--out=/tmp/o"])
    expect(opts.corpusDir).toBe("/tmp/c")
    expect(opts.outDir).toBe("/tmp/o")
  })

  test("rejects a non-positive repeat count", () => {
    expect(() => parseBenchArgs(["--repeats=0"])).toThrow()
    expect(() => parseBenchArgs(["--repeats=nope"])).toThrow()
  })

  test("ignores unknown flags rather than crashing", () => {
    expect(parseBenchArgs(["--verbose", "positional"]).repeats).toBe(5)
  })
})

describe("bench-core assessOutcome", () => {
  test("low signals allow", () => {
    expect(assessOutcome(scores())).toBe("allow")
  })

  test("a signal at the block threshold blocks", () => {
    expect(assessOutcome(scores({ destructive: 0.9 }))).toBe("block")
  })

  test("a signal between ask and block asks", () => {
    expect(assessOutcome(scores({ severity: 0.7 }))).toBe("ask")
  })

  test("no confident signal is unjudged", () => {
    expect(assessOutcome(scores({}, 0.1))).toBe("unjudged")
  })
})

describe("bench-core confusion", () => {
  const entries = [
    { expected: "allow" as const, outcome: "allow" as const },
    { expected: "block" as const, outcome: "block" as const },
    { expected: "ask" as const, outcome: "allow" as const },
  ]

  test("counts outcomes and agreement", () => {
    const result = confusion(entries)
    expect(result.total).toBe(3)
    expect(result.allow).toBe(2)
    expect(result.block).toBe(1)
    expect(result.agree).toBe(2)
    expect(result.accuracy).toBeCloseTo(2 / 3, 10)
  })

  test("zero entries is safe", () => {
    const result = confusion([])
    expect(result.total).toBe(0)
    expect(result.accuracy).toBe(0)
  })
})
