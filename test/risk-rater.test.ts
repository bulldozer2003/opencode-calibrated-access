import { describe, expect, test } from "bun:test"
import { rateCommand } from "../src/risk-rater.ts"
import type { CalibratedConfig } from "../src/types.ts"

const testConfig: CalibratedConfig = {
  riskThresholdBash: 0.4,
  riskThresholdDirectory: 0.3,
  provider: "typesafe",
  systemOneBaseUrl: "https://api.typesafe.ai/v1",
  systemOneModel: "jev-latest",
  systemOneApiKey: "sk-test",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: undefined,
  openaiApiKey: undefined,
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
    expect(rateCommand("rm -rf /", [], testConfig, false, errorFetch(401, "invalid key"))).rejects.toThrow(/System One API error/)
  })

  test("throws on missing System One API key", async () => {
    const config = { ...testConfig, systemOneApiKey: undefined }
    expect(rateCommand("ls", [], config)).rejects.toThrow(/System One API key/)
  })
})

describe("rateCommand (openai-compatible provider)", () => {
  const openAIConfig: CalibratedConfig = {
    ...testConfig,
    provider: "openai-compatible",
    openaiApiKey: "sk-openai-test",
    openaiModel: "gpt-4o-mini",
  }

  function openAIOkFetch(content: string): FetchFn {
    return async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content } }],
      }),
    }) as any
  }

  function openAIErrorFetch(status: number, text: string): FetchFn {
    return async () => ({
      ok: false,
      status,
      json: async () => ({}),
      text: async () => text,
    }) as any
  }

  test("routes to openai provider when configured", async () => {
    const result = await rateCommand("git push --force", ["user said push"], openAIConfig, false, openAIOkFetch(JSON.stringify({
      alignment: { score: 1, confidence: 0.9 },
      impact: { score: 2, confidence: 0.8 },
    })))
    expect(result.alignment).toBe(1)
    expect(result.impact).toBe(2)
    expect(result.confidence).toBeCloseTo(0.8, 1)
  })

  test("sends correct request body to openai-compatible endpoint", async () => {
    let sentUrl = ""
    let sentBody: unknown = null
    const fetch: FetchFn = async (url, opts) => {
      sentUrl = url
      sentBody = JSON.parse(opts.body as string)
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ alignment: { score: 0, confidence: 1 }, impact: { score: 0, confidence: 1 } }) } }],
        }),
      } as any
    }
    await rateCommand("npm install", ["user said install"], openAIConfig, false, fetch)
    expect(sentUrl).toBe("https://api.openai.com/v1/chat/completions")
    const body = sentBody as Record<string, unknown>
    expect(body.model).toBe("gpt-4o-mini")
    expect((body.messages as Array<Record<string, unknown>>)[1]!.content).toContain("npm install")
  })

  test("sends isRetry in prompt when retrying after denial", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ alignment: { score: 3, confidence: 0.9 }, impact: { score: 3, confidence: 0.9 } }) } }],
        }),
      } as any
    }
    await rateCommand("rm file", ["user said do it"], openAIConfig, true, fetch)
    const content = (sentBody as any).messages[1].content as string
    expect(content).toContain("previously blocked")
  })

  test("throws on API error from openai endpoint", async () => {
    expect(rateCommand("ls", [], openAIConfig, false, openAIErrorFetch(401, "invalid key"))).rejects.toThrow(/OpenAI-compatible API error/)
  })

  test("throws on missing openai API key", async () => {
    const config = { ...openAIConfig, openaiApiKey: undefined }
    expect(rateCommand("ls", [], config)).rejects.toThrow(/OPENAI_API_KEY/)
  })

  test("parses and clamps scores from openai response", async () => {
    const result = await rateCommand("echo hello", [], openAIConfig, false, openAIOkFetch(JSON.stringify({
      alignment: { score: 4.5, confidence: 1.2 },
      impact: { score: -1, confidence: -0.5 },
    })))
    expect(result.alignment).toBe(4)
    expect(result.impact).toBe(0)
    expect(result.confidence).toBe(0)
  })

  test("uses custom base URL when set", async () => {
    const customConfig = { ...openAIConfig, openaiBaseUrl: "https://my-proxy.example.com/v1" }
    let sentUrl = ""
    const fetch: FetchFn = async (url, opts) => {
      sentUrl = url
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ alignment: { score: 0, confidence: 1 }, impact: { score: 0, confidence: 1 } }) } }],
        }),
      } as any
    }
    await rateCommand("ls", [], customConfig, false, fetch)
    expect(sentUrl).toBe("https://my-proxy.example.com/v1/chat/completions")
  })

  test("strips trailing slash from base URL", async () => {
    const customConfig = { ...openAIConfig, openaiBaseUrl: "https://my-proxy.example.com/v1/" }
    let sentUrl = ""
    const fetch: FetchFn = async (url, opts) => {
      sentUrl = url
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ alignment: { score: 0, confidence: 1 }, impact: { score: 0, confidence: 1 } }) } }] }) } as any
    }
    await rateCommand("ls", [], customConfig, false, fetch)
    expect(sentUrl).toBe("https://my-proxy.example.com/v1/chat/completions")
    expect(sentUrl).not.toContain("//chat")
  })

  test("throws on empty choices array", async () => {
    const fetch: FetchFn = async () => ({
      ok: true,
      json: async () => ({ choices: [] }),
    }) as any
    expect(rateCommand("ls", [], openAIConfig, false, fetch)).rejects.toThrow(/empty response/)
  })

  test("throws on null content in response", async () => {
    const fetch: FetchFn = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null } }] }),
    }) as any
    expect(rateCommand("ls", [], openAIConfig, false, fetch)).rejects.toThrow(/empty response/)
  })

  test("throws on non-JSON content", async () => {
    const fetch: FetchFn = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "not json at all" } }] }),
    }) as any
    expect(rateCommand("ls", [], openAIConfig, false, fetch)).rejects.toThrow(/invalid JSON/)
  })

  test("clamps Infinity and -Infinity scores", async () => {
    const result = await rateCommand("echo hi", [], openAIConfig, false, openAIOkFetch(JSON.stringify({
      alignment: { score: Infinity, confidence: Infinity },
      impact: { score: -Infinity, confidence: -Infinity },
    })))
    expect(result.alignment).toBe(2)
    expect(result.impact).toBe(2)
    expect(result.confidence).toBe(0)
  })

  test("sanitizes API keys from error messages", async () => {
    const fetch: FetchFn = async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => "Invalid API key: sk-abc123def456ghi789jkl",
    }) as any
    await expect(rateCommand("ls", [], openAIConfig, false, fetch)).rejects.toThrow(/\[KEY_REDACTED\]/)
  })

  test("uses response_format only for known OpenAI hosts", async () => {
    let sentBody: unknown = null
    const customConfig = { ...openAIConfig, openaiBaseUrl: "https://ollama.local/v1" }
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ alignment: { score: 0, confidence: 1 }, impact: { score: 0, confidence: 1 } }) } }] }) } as any
    }
    await rateCommand("ls", [], customConfig, false, fetch)
    expect((sentBody as any).response_format).toBeUndefined()
  })

  test("passes AbortSignal to fetch", async () => {
    let receivedSignal: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      receivedSignal = opts.signal
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ alignment: { score: 0, confidence: 1 }, impact: { score: 0, confidence: 1 } }) } }] }) } as any
    }
    await rateCommand("ls", [], openAIConfig, false, fetch)
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
  })

  test("handles missing fields in openai response gracefully", async () => {
    const result = await rateCommand("echo hi", [], openAIConfig, false, openAIOkFetch(JSON.stringify({})))
    expect(result.alignment).toBe(2)
    expect(result.impact).toBe(2)
    expect(result.confidence).toBe(0)
  })
})