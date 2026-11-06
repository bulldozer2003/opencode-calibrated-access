import { describe, expect, test } from "bun:test"
import { readFileSync, unlinkSync } from "fs"
import { reviewAndReply } from "../src/dispatch.ts"
import { parseConfig } from "../src/config.ts"
import { SessionApprovalCache } from "../src/cache.ts"
import type { FetchFn } from "../src/risk-rater.ts"
import type { PermissionRequest, ReviewerClient, RuntimeContext, SignalName } from "../src/types.ts"
import { SIGNAL_NAMES } from "../src/types.ts"

type ReplyInput = Parameters<ReviewerClient["reply"]>[0]

interface Harness {
  context: RuntimeContext
  client: ReviewerClient
  replies: ReplyInput[]
  toasts: Array<{ title?: string; message: string; variant?: string }>
}

function makeHarness(): Harness {
  const replies: ReplyInput[] = []
  const toasts: Harness["toasts"] = []
  const context: RuntimeContext = {
    options: {},
    client: {},
    data: {
      on: () => () => {},
      session: {
        root: () => "root1",
        get: () => undefined,
        message: { list: () => [], get: () => undefined, sync: async () => {} },
        permission: { list: () => undefined, sync: async () => {} },
      },
    },
    showToast: (input) => toasts.push(input),
  }
  const client: ReviewerClient = {
    async reply(input) {
      replies.push(input)
      return "replied"
    },
  }
  return { context, client, replies, toasts }
}

function systemOneBody(overrides: Partial<Record<SignalName, { score?: number; confidence?: number }>> = {}) {
  const answers: Record<string, { type: string; score: number; confidence: number }> = {}
  for (const signal of SIGNAL_NAMES) {
    answers[signal] = { type: "score", score: 0, confidence: 1, ...overrides[signal] }
  }
  return { model: "jev-latest", answers }
}

function okFetch(response: Record<string, unknown>): FetchFn {
  return (async () => ({ ok: true, status: 200, json: async () => response, text: async () => "" })) as unknown as FetchFn
}

function failingFetch(): FetchFn {
  return (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" })) as unknown as FetchFn
}

function unconfidentBody(): FetchFn {
  return okFetch(
    systemOneBody({
      destructive: { score: 4, confidence: 0.4 },
      secret_exposure: { score: 4, confidence: 0.4 },
      exfiltration: { score: 4, confidence: 0.4 },
      prompt_injection: { score: 4, confidence: 0.4 },
      scope_creep: { score: 4, confidence: 0.4 },
      user_requested: { score: 4, confidence: 0.4 },
      severity: { score: 4, confidence: 0.4 },
    }),
  )
}

const request: PermissionRequest = {
  id: "req1",
  sessionID: "sess1",
  action: "bash",
  resources: ["echo hi > /tmp/x"],
  always: [],
  protocol: "v2",
}

async function run(mode: "shadow" | "enforce", fetchFn: FetchFn): Promise<Harness> {
  const harness = makeHarness()
  const config = parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode })
  await reviewAndReply(
    harness.context,
    harness.client,
    config,
    request,
    new SessionApprovalCache(),
    performance.now(),
    new AbortController().signal,
    fetchFn,
  )
  return harness
}

async function runWithDiagnostics(mode: "shadow" | "enforce", fetchFn: FetchFn): Promise<{ harness: Harness; decision: Record<string, unknown> }> {
  const path = `/tmp/calibrated-access-dispatch-${crypto.randomUUID()}.jsonl`
  const harness = makeHarness()
  const config = parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode, diagnosticsPath: path })
  await reviewAndReply(
    harness.context,
    harness.client,
    config,
    request,
    new SessionApprovalCache(),
    performance.now(),
    new AbortController().signal,
    fetchFn,
  )
  const decision = JSON.parse(readFileSync(path, "utf-8").trim().split("\n").pop()!)
  unlinkSync(path)
  return { harness, decision }
}

describe("dispatch — enforce mode", () => {
  test("blocks when a signal meets the block threshold", async () => {
    const { replies } = await run("enforce", okFetch(systemOneBody({ destructive: { score: 4, confidence: 0.9 } })))
    expect(replies[0]!.reply).toBe("reject")
    expect(replies[0]!.message).toContain("destructive")
  })

  test("blocks with a context-specific reason code when a signal meets the ask threshold", async () => {
    const { replies } = await run("enforce", okFetch(systemOneBody({ destructive: { score: 3, confidence: 0.9 } })))
    expect(replies[0]!.reply).toBe("reject")
    expect(replies[0]!.message).toMatch(/confirm|ask/i)
  })

  test("allows when all signals are below threshold", async () => {
    const { replies } = await run("enforce", okFetch(systemOneBody()))
    expect(replies[0]!.reply).toBe("once")
    expect(replies[0]!.message).toBeUndefined()
  })

  test("fail-closed: blocks when the rater fails", async () => {
    const { replies } = await run("enforce", failingFetch())
    expect(replies[0]!.reply).toBe("reject")
  })

  test("fail-closed: blocks when no risk signal reaches the confidence floor", async () => {
    const { harness, decision } = await runWithDiagnostics("enforce", unconfidentBody())
    expect(harness.replies[0]!.reply).toBe("reject")
    expect(harness.replies[0]!.message).toMatch(/no confident assessment/i)
    expect(decision.reasonCode).toBe("no_confident_signals")
  })
})

describe("dispatch — shadow mode", () => {
  test("replies once and toasts when a signal would have blocked", async () => {
    const { replies, toasts } = await run("shadow", okFetch(systemOneBody({ destructive: { score: 4, confidence: 0.9 } })))
    expect(replies[0]!.reply).toBe("once")
    expect(replies[0]!.message).toBeUndefined()
    expect(toasts.some((t) => /shadow mode: would have blocked/i.test(t.message))).toBe(true)
  })

  test("distinguishes the ask tier in the shadow toast", async () => {
    const { toasts } = await run("shadow", okFetch(systemOneBody({ destructive: { score: 3, confidence: 0.9 } })))
    const message = toasts.find((t) => /shadow mode/i.test(t.message))?.message ?? ""
    expect(message).toMatch(/would have denied pending user confirmation/i)
    expect(message).not.toMatch(/would have blocked/i)
  })

  test("replies once with no toast when all signals are below threshold", async () => {
    const { replies, toasts } = await run("shadow", okFetch(systemOneBody()))
    expect(replies[0]!.reply).toBe("once")
    expect(toasts.length).toBe(0)
  })

  test("replies once when the rater fails (shadow never blocks)", async () => {
    const { replies } = await run("shadow", failingFetch())
    expect(replies[0]!.reply).toBe("once")
  })

  test("toasts would-have-blocked when no risk signal reaches the confidence floor", async () => {
    const { harness, decision } = await runWithDiagnostics("shadow", unconfidentBody())
    expect(harness.replies[0]!.reply).toBe("once")
    expect(harness.replies[0]!.message).toBeUndefined()
    expect(harness.toasts.some((t) => /would have blocked \(no confident signals\)/i.test(t.message))).toBe(true)
    expect(decision.reasonCode).toBe("shadow_unjudged")
  })
})

describe("dispatch — shadow mode session cache isolation", () => {
  test("does not reuse a shadow-mode would-deny as a session approval in enforce mode", async () => {
    const harness = makeHarness()
    const cache = new SessionApprovalCache()
    const scoped: PermissionRequest = { ...request, always: ["bash:echo hi > /tmp/x"] }
    const config = (mode: "shadow" | "enforce") =>
      parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode })
    const blockBody = okFetch(systemOneBody({ destructive: { score: 4, confidence: 0.9 } }))

    await reviewAndReply(
      harness.context,
      harness.client,
      config("shadow"),
      scoped,
      cache,
      performance.now(),
      new AbortController().signal,
      blockBody,
    )
    expect(harness.replies[0]!.reply).toBe("once")

    await reviewAndReply(
      harness.context,
      harness.client,
      config("enforce"),
      scoped,
      cache,
      performance.now(),
      new AbortController().signal,
      blockBody,
    )
    expect(harness.replies[1]!.reply).toBe("reject")
  })

  test("does not reuse a shadow-mode unjudged result as a session approval in enforce mode", async () => {
    const harness = makeHarness()
    const cache = new SessionApprovalCache()
    const scoped: PermissionRequest = { ...request, always: ["bash:echo hi > /tmp/x"] }
    const config = (mode: "shadow" | "enforce") =>
      parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode })
    const body = unconfidentBody()

    await reviewAndReply(
      harness.context,
      harness.client,
      config("shadow"),
      scoped,
      cache,
      performance.now(),
      new AbortController().signal,
      body,
    )
    expect(harness.replies[0]!.reply).toBe("once")

    await reviewAndReply(
      harness.context,
      harness.client,
      config("enforce"),
      scoped,
      cache,
      performance.now(),
      new AbortController().signal,
      body,
    )
    expect(harness.replies[1]!.reply).toBe("reject")
  })
})
