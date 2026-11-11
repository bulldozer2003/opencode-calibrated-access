import { describe, expect, test } from "bun:test"
import { rateCommand } from "../src/risk-rater.ts"
import { DEFAULT_SIGNAL_THRESHOLDS } from "../src/matrix.ts"
import { SIGNAL_DEFINITIONS } from "../src/signals.ts"
import { PROMPT_VERSION } from "../src/prompt.ts"
import type { CalibratedConfig, SignalName } from "../src/types.ts"
import { SIGNAL_NAMES } from "../src/types.ts"

const testConfig: CalibratedConfig = {
  mode: "enforce",
  signalThresholds: DEFAULT_SIGNAL_THRESHOLDS,
  provider: "typesafe",
  systemOneBaseUrl: "https://api.typesafe.ai/v1",
  systemOneModel: "jev-latest",
  systemOneApiKey: "sk-test",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-4o-mini",
  openaiApiKey: undefined,
  sessionApprovals: true,
  contextMessageCount: 3,
  diagnosticsPath: undefined,
}

type FetchFn = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

function answers(overrides: Partial<Record<SignalName, { score?: number; confidence?: number }>> = {}) {
  const out: Record<string, { type: string; score: number; confidence: number }> = {}
  for (const signal of SIGNAL_NAMES) {
    out[signal] = { type: "score", score: 0, confidence: 1, ...overrides[signal] }
  }
  return out
}

function signalJson(overrides: Partial<Record<SignalName, { score?: number; confidence?: number }>> = {}) {
  const out: Record<string, { score: number; confidence: number }> = {}
  for (const signal of SIGNAL_NAMES) {
    out[signal] = { score: 0, confidence: 1, ...overrides[signal] }
  }
  return JSON.stringify(out)
}

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
  test("bumps the prompt version to 3 for the justification guidance", () => {
    expect(PROMPT_VERSION).toBe("3")
  })

  test("returns parsed signal probabilities and confidence", async () => {
    const result = await rateCommand("git push --force", ["some context"], testConfig, false, okFetch({
      model: "jev-1.13.0",
      answers: answers({ destructive: { score: 2, confidence: 0.8 } }),
    }))
    expect(result.signals.destructive.probability).toBeCloseTo(0.5, 5)
    expect(result.signals.destructive.confidence).toBeCloseTo(0.8, 1)
    expect(result.signals.user_requested.probability).toBe(0)
  })

  test("sends one question per signal in the request body", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return okFetch({ model: "jev-1.13.0", answers: answers() })(_url, opts)
    }
    await rateCommand("npm install", ["user said install"], testConfig, false, fetch)
    const body = sentBody as Record<string, any>
    expect(body.model).toBe("jev-latest")
    expect(body.state.command).toBe("npm install")
    expect(body.state.isRetry).toBe(false)
    expect(Object.keys(body.questions).sort()).toEqual([...SIGNAL_NAMES].sort())
    expect(body.questions.destructive.type).toBe("score")
    expect(body.questions.destructive.instructions).toBe(SIGNAL_DEFINITIONS.destructive)
    expect(body.questions.user_requested.type).toBe("score")
  })

  test("exposes the user_prohibited trigger contexts in the System One question", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return okFetch({ model: "jev-1.13.0", answers: answers() })(_url, opts)
    }
    await rateCommand("git add .", ["the user said .env stays out of the repo"], testConfig, false, fetch)
    const instructions = (sentBody as any).questions.user_prohibited.instructions as string
    expect(instructions).toContain(SIGNAL_DEFINITIONS.user_prohibited)
    expect(instructions).toMatch(/staging/i)
    expect(instructions).toMatch(/secret files/i)
    expect(instructions).toMatch(/off-limits/i)
  })

  test("sends deterministic findings and the prompt version in the judge state", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return okFetch({ model: "jev-1.13.0", answers: answers() })(_url, opts)
    }
    const finding = {
      code: "secret_exposure" as const,
      severity: "caution" as const,
      message: "caution: command matches a secret-file-read pattern (.env)",
    }
    await rateCommand("cat .env", ["show the scratch fixture"], testConfig, false, fetch, [finding])
    const state = (sentBody as any).state
    expect(state.promptVersion).toBe(PROMPT_VERSION)
    expect(state.deterministicFindings).toEqual([{ code: "secret_exposure", message: finding.message }])
    expect(state.findingGuidance).toContain("cautionary pre-checks")
    expect(state.findingGuidance).toContain("not verdicts")
  })

  test("always carries the prompt version but omits findings when none are supplied", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return okFetch({ model: "jev-1.13.0", answers: answers() })(_url, opts)
    }
    await rateCommand("git status", [], testConfig, false, fetch)
    const state = (sentBody as any).state
    expect(state.promptVersion).toBe(PROMPT_VERSION)
    expect(state.deterministicFindings).toBeUndefined()
    expect(state.findingGuidance).toBeUndefined()
  })

  test("sends isRetry=true in state when retrying after denial", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return okFetch({ model: "jev-1.13.0", answers: answers() })(_url, opts)
    }
    await rateCommand("rm file", ["user said do it"], testConfig, true, fetch)
    expect((sentBody as any).state.isRetry).toBe(true)
  })

  test("sends the retry justification in the System One judge state", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return okFetch({ model: "jev-1.13.0", answers: answers() })(_url, opts)
    }
    const justification = "The user asked to create the PR; the destination is this repo's own remote."
    await rateCommand("gh pr create", ["user asked"], testConfig, true, fetch, [], justification)
    const state = (sentBody as any).state
    expect(state.justification).toBe(justification)
    expect(state.justificationGuidance).toContain("justification")
    expect(state.promptVersion).toBe(PROMPT_VERSION)
  })

  test("omits the justification from the judge state when none is supplied", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return okFetch({ model: "jev-1.13.0", answers: answers() })(_url, opts)
    }
    await rateCommand("git status", [], testConfig, false, fetch)
    const state = (sentBody as any).state
    expect(state.justification).toBeUndefined()
    expect(state.justificationGuidance).toBeUndefined()
  })

  test("throws on API error", async () => {
    await expect(rateCommand("rm -rf /", [], testConfig, false, errorFetch(401, "invalid key"))).rejects.toThrow(/System One API error/)
  })

  test("throws on missing System One API key", async () => {
    const config = { ...testConfig, systemOneApiKey: undefined }
    await expect(rateCommand("ls", [], config)).rejects.toThrow(/System One API key/)
  })

  test("sends request to {systemOneBaseUrl}/systemone endpoint", async () => {
    let sentUrl = ""
    const fetch: FetchFn = async (url, opts) => {
      sentUrl = url
      return okFetch({ model: "jev-1.13.0", answers: answers() })(url, opts)
    }
    await rateCommand("npm install", [], testConfig, false, fetch)
    expect(sentUrl).toBe("https://api.typesafe.ai/v1/systemone")
  })

  test("strips /systemone suffix and trailing slashes from systemOneBaseUrl", async () => {
    const customConfig = { ...testConfig, systemOneBaseUrl: "http://localhost:8000/v1/systemone/" }
    let sentUrl = ""
    const fetch: FetchFn = async (url, opts) => {
      sentUrl = url
      return okFetch({ model: "jev-1.13.0", answers: answers() })(url, opts)
    }
    await rateCommand("ls", [], customConfig, false, fetch)
    expect(sentUrl).toBe("http://localhost:8000/v1/systemone")
  })

  test("rejects non-numeric System One scores instead of defaulting", async () => {
    await expect(
      rateCommand("rm -rf /", [], testConfig, false, okFetch({
        model: "jev-1.13.0",
        answers: { ...answers(), destructive: { type: "score", score: "3", confidence: 0.9 } },
      })),
    ).rejects.toThrow(/System One API response missing required score/)
  })

  test("throws when a signal answer is missing", async () => {
    const partial = answers()
    delete partial.secret_exposure
    await expect(
      rateCommand("rm -rf /", [], testConfig, false, okFetch({ model: "jev-1.13.0", answers: partial })),
    ).rejects.toThrow(/System One API response missing required score/)
  })

  test("surfaces usage and cost from the System One response", async () => {
    const result = await rateCommand("ls", [], testConfig, false, okFetch({
      model: "jev-1.13.0",
      answers: answers(),
      usage: { input_tokens: 812, output_tokens: 120 },
      cost: { usd: 0.0000341 },
    }))
    expect(result.usage).toEqual({ input_tokens: 812, output_tokens: 120 })
    expect(result.cost).toEqual({ usd: 0.0000341 })
  })

  test("leaves usage and cost undefined when the System One response omits them", async () => {
    const result = await rateCommand("ls", [], testConfig, false, okFetch({ model: "jev-1.13.0", answers: answers() }))
    expect(result.usage).toBeUndefined()
    expect(result.cost).toBeUndefined()
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
    const result = await rateCommand("git push --force", ["user said push"], openAIConfig, false, openAIOkFetch(
      signalJson({ destructive: { score: 2, confidence: 0.8 } }),
    ))
    expect(result.signals.destructive.probability).toBeCloseTo(0.5, 5)
    expect(result.signals.destructive.confidence).toBeCloseTo(0.8, 1)
  })

  test("sends every signal in the system prompt", async () => {
    let sentUrl = ""
    let sentBody: unknown = null
    const fetch: FetchFn = async (url, opts) => {
      sentUrl = url
      sentBody = JSON.parse(opts.body as string)
      return { ok: true, json: async () => ({ choices: [{ message: { content: signalJson() } }] }) } as any
    }
    await rateCommand("npm install", ["user said install"], openAIConfig, false, fetch)
    expect(sentUrl).toBe("https://api.openai.com/v1/chat/completions")
    const body = sentBody as Record<string, any>
    expect(body.model).toBe("gpt-4o-mini")
    const system = body.messages[0].content as string
    for (const signal of SIGNAL_NAMES) expect(system).toContain(`"${signal}"`)
    expect(body.messages[1].content).toContain("npm install")
  })

  test("exposes the user_prohibited trigger contexts in the OpenAI system prompt", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return { ok: true, json: async () => ({ choices: [{ message: { content: signalJson() } }] }) } as any
    }
    await rateCommand("git add .", ["the user said .env stays out of the repo"], openAIConfig, false, fetch)
    const system = (sentBody as any).messages[0].content as string
    expect(system).toContain(SIGNAL_DEFINITIONS.user_prohibited)
    expect(system).toMatch(/staging/i)
    expect(system).toMatch(/secret files/i)
    expect(system).toMatch(/off-limits/i)
  })

  test("includes the finding guidance and deterministic findings in the OpenAI prompt", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return { ok: true, json: async () => ({ choices: [{ message: { content: signalJson() } }] }) } as any
    }
    const finding = {
      code: "secret_exposure" as const,
      severity: "caution" as const,
      message: "caution: command matches a secret-file-read pattern (.env)",
    }
    await rateCommand("cat .env", ["show the scratch fixture"], openAIConfig, false, fetch, [finding])
    const system = (sentBody as any).messages[0].content as string
    const user = (sentBody as any).messages[1].content as string
    expect(system).toContain("cautionary pre-checks")
    expect(system).toContain("not verdicts")
    expect(user).toContain("Deterministic findings")
    expect(user).toContain("caution: command matches a secret-file-read pattern")
    expect(user).toContain(`Prompt version: ${PROMPT_VERSION}`)
  })

  test("sends isRetry in prompt when retrying after denial", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return { ok: true, json: async () => ({ choices: [{ message: { content: signalJson() } }] }) } as any
    }
    await rateCommand("rm file", ["user said do it"], openAIConfig, true, fetch)
    const content = (sentBody as any).messages[1].content as string
    expect(content).toContain("previously blocked")
  })

  test("sends the retry justification in the OpenAI prompt", async () => {
    let sentBody: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      sentBody = JSON.parse(opts.body as string)
      return { ok: true, json: async () => ({ choices: [{ message: { content: signalJson() } }] }) } as any
    }
    const justification = "The user asked to create the PR; the destination is this repo's own remote."
    await rateCommand("gh pr create", ["user asked"], openAIConfig, true, fetch, [], justification)
    const system = (sentBody as any).messages[0].content as string
    const user = (sentBody as any).messages[1].content as string
    expect(system).toContain("justification")
    expect(user).toContain("Justification:")
    expect(user).toContain(justification)
  })

  test("throws on API error from openai endpoint", async () => {
    await expect(rateCommand("ls", [], openAIConfig, false, openAIErrorFetch(401, "invalid key"))).rejects.toThrow(/OpenAI-compatible API error/)
  })

  test("throws on missing openai API key", async () => {
    const config = { ...openAIConfig, openaiApiKey: undefined }
    await expect(rateCommand("ls", [], config)).rejects.toThrow(/OPENAI_API_KEY/)
  })

  test("parses and clamps scores from openai response", async () => {
    const result = await rateCommand("echo hello", [], openAIConfig, false, openAIOkFetch(
      signalJson({ destructive: { score: 4.5, confidence: 1.2 }, exfiltration: { score: -1, confidence: -0.5 } }),
    ))
    expect(result.signals.destructive.probability).toBe(1)
    expect(result.signals.exfiltration.probability).toBe(0)
    expect(result.signals.exfiltration.confidence).toBe(0)
  })

  test("uses custom base URL when set", async () => {
    const customConfig = { ...openAIConfig, openaiBaseUrl: "https://my-proxy.example.com/v1" }
    let sentUrl = ""
    const fetch: FetchFn = async (url, _opts) => {
      sentUrl = url
      return { ok: true, json: async () => ({ choices: [{ message: { content: signalJson() } }] }) } as any
    }
    await rateCommand("ls", [], customConfig, false, fetch)
    expect(sentUrl).toBe("https://my-proxy.example.com/v1/chat/completions")
  })

  test("strips trailing slash from base URL", async () => {
    const customConfig = { ...openAIConfig, openaiBaseUrl: "https://my-proxy.example.com/v1/" }
    let sentUrl = ""
    const fetch: FetchFn = async (url, _opts) => {
      sentUrl = url
      return { ok: true, json: async () => ({ choices: [{ message: { content: signalJson() } }] }) } as any
    }
    await rateCommand("ls", [], customConfig, false, fetch)
    expect(sentUrl).toBe("https://my-proxy.example.com/v1/chat/completions")
    expect(sentUrl).not.toContain("//chat")
  })

  test("does not strip /systemone suffix from openai base URL", async () => {
    const customConfig = { ...openAIConfig, openaiBaseUrl: "https://my-proxy.example.com/v1/systemone" }
    let sentUrl = ""
    const fetch: FetchFn = async (url, _opts) => {
      sentUrl = url
      return { ok: true, json: async () => ({ choices: [{ message: { content: signalJson() } }] }) } as any
    }
    await rateCommand("ls", [], customConfig, false, fetch)
    expect(sentUrl).toBe("https://my-proxy.example.com/v1/systemone/chat/completions")
  })

  test("throws on empty choices array", async () => {
    const fetch: FetchFn = async () => ({
      ok: true,
      json: async () => ({ choices: [] }),
    }) as any
    await expect(rateCommand("ls", [], openAIConfig, false, fetch)).rejects.toThrow(/empty response/)
  })

  test("throws on null content in response", async () => {
    const fetch: FetchFn = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null } }] }),
    }) as any
    await expect(rateCommand("ls", [], openAIConfig, false, fetch)).rejects.toThrow(/empty response/)
  })

  test("throws on non-JSON content", async () => {
    const fetch: FetchFn = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "not json at all" } }] }),
    }) as any
    await expect(rateCommand("ls", [], openAIConfig, false, fetch)).rejects.toThrow(/invalid JSON/)
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
      return { ok: true, json: async () => ({ choices: [{ message: { content: signalJson() } }] }) } as any
    }
    await rateCommand("ls", [], customConfig, false, fetch)
    expect((sentBody as any).response_format).toBeUndefined()
  })

  test("passes AbortSignal to fetch", async () => {
    let receivedSignal: unknown = null
    const fetch: FetchFn = async (_url, opts) => {
      receivedSignal = opts.signal
      return { ok: true, json: async () => ({ choices: [{ message: { content: signalJson() } }] }) } as any
    }
    await rateCommand("ls", [], openAIConfig, false, fetch)
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
  })

  test("throws when openai response is missing score fields", async () => {
    await expect(rateCommand("echo hi", [], openAIConfig, false, openAIOkFetch(JSON.stringify({})))).rejects.toThrow(/missing required score/)
  })

  test("throws when openai response omits a single signal", async () => {
    const parsed = JSON.parse(signalJson()) as Record<string, unknown>
    delete parsed.secret_exposure
    await expect(
      rateCommand("echo hi", [], openAIConfig, false, openAIOkFetch(JSON.stringify(parsed))),
    ).rejects.toThrow(/missing required score/)
  })

  test("accepts openai scores with missing confidence (clamps to 0)", async () => {
    const result = await rateCommand("echo hi", [], openAIConfig, false, openAIOkFetch(JSON.stringify({
      destructive: { score: 2 },
      secret_exposure: { score: 2 },
      exfiltration: { score: 2 },
      prompt_injection: { score: 2 },
      scope_creep: { score: 2 },
      user_requested: { score: 2 },
      user_prohibited: { score: 2 },
      severity: { score: 2 },
    })))
    expect(result.signals.destructive.probability).toBeCloseTo(0.5, 5)
    expect(result.signals.destructive.confidence).toBe(0)
  })

  test("rejects non-numeric openai scores instead of defaulting", async () => {
    await expect(
      rateCommand("rm -rf /", [], openAIConfig, false, openAIOkFetch(signalJson({ destructive: { score: "high" as unknown as number, confidence: 0.9 } }))),
    ).rejects.toThrow(/missing required score/)
  })

  test("rejects non-finite openai scores instead of defaulting", async () => {
    await expect(
      rateCommand("rm -rf /", [], openAIConfig, false, openAIOkFetch('{"destructive":{"score":1e400,"confidence":0.9},"secret_exposure":{"score":2,"confidence":0.8}}')),
    ).rejects.toThrow(/missing required score/)
  })

  test("surfaces usage from the openai chat-completions response", async () => {
    const fetch: FetchFn = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: signalJson() } }],
        usage: { prompt_tokens: 700, completion_tokens: 80 },
      }),
    }) as any
    const result = await rateCommand("ls", [], openAIConfig, false, fetch)
    expect(result.usage).toEqual({ prompt_tokens: 700, completion_tokens: 80 })
  })

  test("leaves usage undefined when the openai response omits it", async () => {
    const result = await rateCommand("ls", [], openAIConfig, false, openAIOkFetch(signalJson()))
    expect(result.usage).toBeUndefined()
    expect(result.cost).toBeUndefined()
  })
})
