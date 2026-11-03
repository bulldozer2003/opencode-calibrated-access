import { describe, expect, test } from "bun:test"
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
})

describe("dispatch — shadow mode", () => {
  test("replies once and toasts when a signal would have blocked", async () => {
    const { replies, toasts } = await run("shadow", okFetch(systemOneBody({ destructive: { score: 4, confidence: 0.9 } })))
    expect(replies[0]!.reply).toBe("once")
    expect(replies[0]!.message).toBeUndefined()
    expect(toasts.some((t) => /shadow mode: would have blocked/i.test(t.message))).toBe(true)
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
})
