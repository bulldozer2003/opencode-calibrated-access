import { describe, expect, test } from "bun:test"
import { parseConfig } from "../src/config.ts"

describe("parseConfig", () => {
  test("uses defaults when no options provided", () => {
    const saved = process.env.TYPESAFE_API_KEY
    delete process.env.TYPESAFE_API_KEY
    const config = parseConfig({})
    expect(config.riskThresholdBash).toBe(0.4)
    expect(config.riskThresholdDirectory).toBe(0.3)
    expect(config.provider).toBe("typesafe")
    expect(config.systemOneBaseUrl).toBe("https://api.typesafe.ai/v1")
    expect(config.systemOneModel).toBe("jev-latest")
    expect(config.systemOneApiKey).toBeUndefined()
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

  test("accepts custom System One model via systemOneModel", () => {
    const config = parseConfig({ systemOneModel: "jev-1.14" })
    expect(config.systemOneModel).toBe("jev-1.14")
  })

  test("rejects empty System One model", () => {
    expect(() => parseConfig({ systemOneModel: "" })).toThrow(/systemOneModel/)
    expect(() => parseConfig({ systemOneModel: "   " })).toThrow(/systemOneModel/)
  })

  test("backward compat: typesafeModel maps to systemOneModel", () => {
    const config = parseConfig({ typesafeModel: "jev-1.13.0" })
    expect(config.systemOneModel).toBe("jev-1.13.0")
  })

  test("systemOneModel takes precedence over typesafeModel", () => {
    const config = parseConfig({ systemOneModel: "jev-1.14", typesafeModel: "jev-1.13.0" })
    expect(config.systemOneModel).toBe("jev-1.14")
  })

  test("backward compat: typesafeApiKey maps to systemOneApiKey", () => {
    const config = parseConfig({ typesafeApiKey: "sk-test" })
    expect(config.systemOneApiKey).toBe("sk-test")
  })

  test("systemOneApiKey takes precedence over typesafeApiKey", () => {
    const config = parseConfig({ systemOneApiKey: "sk-new", typesafeApiKey: "sk-old" })
    expect(config.systemOneApiKey).toBe("sk-new")
  })

  test("reads System One API key from TYPESAFE_API_KEY env", () => {
    process.env.TYPESAFE_API_KEY = "env-key-test"
    const config = parseConfig({})
    expect(config.systemOneApiKey).toBe("env-key-test")
    delete process.env.TYPESAFE_API_KEY
  })

  test("custom systemOneBaseUrl", () => {
    const config = parseConfig({ systemOneBaseUrl: "https://openrouter.ai/api/v1" })
    expect(config.systemOneBaseUrl).toBe("https://openrouter.ai/api/v1")
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

  test("defaults to typesafe provider", () => {
    const config = parseConfig({})
    expect(config.provider).toBe("typesafe")
  })

  test("accepts openai-compatible provider", () => {
    const config = parseConfig({ provider: "openai-compatible" })
    expect(config.provider).toBe("openai-compatible")
  })

  test("rejects invalid provider", () => {
    expect(() => parseConfig({ provider: "anthropic" })).toThrow(/provider/)
  })

  test("parses openai config options", () => {
    const config = parseConfig({
      openaiBaseUrl: "https://my-proxy.example.com/v1",
      openaiModel: "gpt-4o",
      openaiApiKey: "sk-custom",
    })
    expect(config.openaiBaseUrl).toBe("https://my-proxy.example.com/v1")
    expect(config.openaiModel).toBe("gpt-4o")
    expect(config.openaiApiKey).toBe("sk-custom")
  })

  test("defaults openaiBaseUrl when not set", () => {
    const config = parseConfig({})
    expect(config.openaiBaseUrl).toBe("https://api.openai.com/v1")
  })

  test("reads openai api key from environment", () => {
    process.env.OPENAI_API_KEY = "env-openai-key"
    const config = parseConfig({ provider: "openai-compatible" })
    expect(config.openaiApiKey).toBe("env-openai-key")
    delete process.env.OPENAI_API_KEY
  })
})