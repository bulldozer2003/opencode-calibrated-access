import { describe, expect, test } from "bun:test"
import { parseConfig } from "../src/config.ts"

describe("parseConfig", () => {
  test("uses defaults when no options provided", () => {
    const saved = process.env.TYPESAFE_API_KEY
    delete process.env.TYPESAFE_API_KEY
    const config = parseConfig({})
    expect(config.riskThresholdBash).toBe(0.4)
    expect(config.riskThresholdDirectory).toBe(0.3)
    expect(config.typesafeModel).toBe("jev-latest")
    expect(config.typesafeApiKey).toBeUndefined()
    expect(config.sessionApprovals).toBe(true)
    expect(config.contextMessageCount).toBe(3)
    expect(config.diagnosticsPath).toBeUndefined()
    process.env.TYPESAFE_API_KEY = saved
  })

  test("accepts custom risk thresholds", () => {
    const config = parseConfig({ riskThresholdBash: 0.6, riskThresholdDirectory: 0.2 })
    expect(config.riskThresholdBash).toBe(0.6)
    expect(config.riskThresholdDirectory).toBe(0.2)
  })

  test("rejects out-of-range risk thresholds", () => {
    expect(() => parseConfig({ riskThresholdBash: -0.1 })).toThrow(/riskThresholdBash/)
    expect(() => parseConfig({ riskThresholdBash: 1.1 })).toThrow(/riskThresholdBash/)
    expect(() => parseConfig({ riskThresholdDirectory: -0.1 })).toThrow(/riskThresholdDirectory/)
    expect(() => parseConfig({ riskThresholdDirectory: 1.1 })).toThrow(/riskThresholdDirectory/)
  })

  test("accepts custom TypeSafe model", () => {
    const config = parseConfig({ typesafeModel: "jev-1.13.0" })
    expect(config.typesafeModel).toBe("jev-1.13.0")
  })

  test("rejects empty TypeSafe model", () => {
    expect(() => parseConfig({ typesafeModel: "" })).toThrow(/typesafeModel/)
    expect(() => parseConfig({ typesafeModel: "   " })).toThrow(/typesafeModel/)
  })

  test("accepts API key from options or env", () => {
    const config = parseConfig({ typesafeApiKey: "sk-test" })
    expect(config.typesafeApiKey).toBe("sk-test")
  })

  test("reads API key from environment", () => {
    process.env.TYPESAFE_API_KEY = "env-key-test"
    const config = parseConfig({})
    expect(config.typesafeApiKey).toBe("env-key-test")
    delete process.env.TYPESAFE_API_KEY
  })

  test("disables session approvals", () => {
    expect(parseConfig({ sessionApprovals: false }).sessionApprovals).toBe(false)
    expect(parseConfig({}).sessionApprovals).toBe(true)
  })

  test("bounds context message count", () => {
    expect(parseConfig({ contextMessageCount: 5 }).contextMessageCount).toBe(5)
    expect(() => parseConfig({ contextMessageCount: 0 })).toThrow(/contextMessageCount/)
    expect(() => parseConfig({ contextMessageCount: 11 })).toThrow(/contextMessageCount/)
  })

  test("enables diagnostics with explicit path", () => {
    const config = parseConfig({ diagnosticsPath: "/tmp/decisions.jsonl" })
    expect(config.diagnosticsPath).toBe("/tmp/decisions.jsonl")
  })
})