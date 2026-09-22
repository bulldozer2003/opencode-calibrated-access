import { describe, expect, test } from "bun:test"
import { rateCommand } from "../src/risk-rater.ts"
import type { CalibratedConfig } from "../src/types.ts"

const testConfig: CalibratedConfig = {
  riskThresholdBash: 0.4,
  riskThresholdDirectory: 0.3,
  typesafeModel: "jev-latest",
  typesafeApiKey: "sk-test",
  sessionApprovals: true,
  contextMessageCount: 3,
  diagnosticsPath: undefined,
}

type FetchFn = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

function okFetch(body: Record<string, unknown>): FetchFn {
  return async () => ({
    ok: true,
    json: async () => body,
  }) as any
}

function errorFetch(status: number, text: string): FetchFn {
  return async () => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  }) as any
}

describe("rateCommand", () => {
  test("returns parsed alignment and impact from API response", async () => {
    const result = await rateCommand("git push --force", ["some context"], testConfig, false, okFetch({
      model: "jev-1.13.0",
      answers: {
        alignment: { type: "score", score: 1, legend: ["a", "b", "c", "d", "e"], probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, confidence: 0.9 },
        impact: { type: "score", score: 2, legend: ["a", "b", "c", "d", "e"], probabilities: { 0: 0, 1: 0, 2: 0.85, 3: 0.15 }, confidence: 0.8 },
      },
      usage: { input_tokens: 200, output_tokens: 40 },
    }))
    expect(result.alignment).toBe(1)
    expect(result.impact).toBe(2)
    expect(result.confidence).toBeCloseTo(0.8, 1)
  })

  test("sends correct request body", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return {
        ok: true,
        json: async () => ({
          model: "jev-1.13.0",
          answers: {
            alignment: { type: "score", score: 0, legend: ["a", "b", "c", "d", "e"], probabilities: { 0: 1 }, confidence: 1 },
            impact: { type: "score", score: 0, legend: ["a", "b", "c", "d", "e"], probabilities: { 0: 1 }, confidence: 1 },
          },
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      } as any
    }
    await rateCommand("npm install", ["user said install"], testConfig, false, fetch)
    const body = sentBody as Record<string, unknown>
    expect(body.model).toBe("jev-latest")
    expect((body as any).state.command).toBe("npm install")
    expect((body as any).state.isRetry).toBe(false)
    expect((body as any).questions.alignment.type).toBe("score")
    expect((body as any).questions.impact.type).toBe("score")
  })

  test("sends isRetry=true in state when retrying after denial", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return {
        ok: true,
        json: async () => ({
          model: "jev-1.13.0",
          answers: {
            alignment: { type: "score", score: 3, legend: ["a", "b", "c", "d", "e"], probabilities: { 3: 1 }, confidence: 1 },
            impact: { type: "score", score: 3, legend: ["a", "b", "c", "d", "e"], probabilities: { 3: 1 }, confidence: 1 },
          },
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      } as any
    }
    await rateCommand("rm file", ["user said do it"], testConfig, true, fetch)
    expect((sentBody as any).state.isRetry).toBe(true)
  })

  test("throws on API error", async () => {
    expect(rateCommand("rm -rf /", [], testConfig, false, errorFetch(401, "invalid key"))).rejects.toThrow(/TypeSafe API error/)
  })

  test("throws on missing API key", async () => {
    const config = { ...testConfig, typesafeApiKey: undefined }
    expect(rateCommand("ls", [], config)).rejects.toThrow(/TYPESAFE_API_KEY/)
  })
})