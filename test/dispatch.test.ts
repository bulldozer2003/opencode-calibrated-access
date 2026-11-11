import { describe, expect, test } from "bun:test"
import { readFileSync, unlinkSync } from "fs"
import { reviewAndReply } from "../src/dispatch.ts"
import { parseConfig } from "../src/config.ts"
import { SessionApprovalCache } from "../src/cache.ts"
import type { FetchFn } from "../src/risk-rater.ts"
import type { PermissionRequest, ReviewerClient, ResumeRouting, RuntimeContext, SignalName } from "../src/types.ts"
import { SIGNAL_NAMES } from "../src/types.ts"

type ReplyInput = Parameters<ReviewerClient["reply"]>[0]

interface Harness {
  context: RuntimeContext
  client: ReviewerClient
  replies: ReplyInput[]
  toasts: Array<{ title?: string; message: string; variant?: string }>
  resumes: Array<{ sessionID: string; reason: string; routing?: ResumeRouting }>
}

function makeHarness(messages: unknown[] = []): Harness {
  const replies: ReplyInput[] = []
  const toasts: Harness["toasts"] = []
  const resumes: Harness["resumes"] = []
  const context: RuntimeContext = {
    options: {},
    client: {},
    data: {
      on: () => () => {},
      session: {
        root: () => "root1",
        get: () => undefined,
        message: { list: () => messages, get: () => undefined, sync: async () => {} },
        permission: { list: () => undefined, sync: async () => {} },
      },
    },
    showToast: (input) => toasts.push(input),
    resumeAfterDenial: (sessionID, reason, routing) => resumes.push({ sessionID, reason, ...(routing ? { routing } : {}) }),
  }
  const client: ReviewerClient = {
    async reply(input) {
      replies.push(input)
      return "replied"
    },
  }
  return { context, client, replies, toasts, resumes }
}

interface SpyHarness extends Harness {
  rootCalls: () => number
  listCalls: () => number
  order: string[]
}

interface SpyOptions {
  failMessages?: boolean
}

function makeSpyHarness(messages: unknown[] = [], options: SpyOptions = {}): SpyHarness {
  const replies: ReplyInput[] = []
  const toasts: Harness["toasts"] = []
  const resumes: Harness["resumes"] = []
  const order: string[] = []
  let rootCalls = 0
  let listCalls = 0
  const context: RuntimeContext = {
    options: {},
    client: {},
    data: {
      on: () => () => {},
      session: {
        root: () => {
          rootCalls += 1
          order.push("root")
          return "root1"
        },
        get: () => undefined,
        message: {
          list: () => {
            listCalls += 1
            order.push("messages")
            if (options.failMessages) throw new Error("messages unavailable")
            return messages
          },
          get: () => undefined,
          sync: async () => {},
        },
        permission: { list: () => undefined, sync: async () => {} },
      },
    },
    showToast: (input) => toasts.push(input),
    resumeAfterDenial: (sessionID, reason, routing) => resumes.push({ sessionID, reason, ...(routing ? { routing } : {}) }),
  }
  const client: ReviewerClient = {
    async reply(input) {
      order.push("reply")
      replies.push(input)
      return "replied"
    },
  }
  return { context, client, replies, toasts, resumes, rootCalls: () => rootCalls, listCalls: () => listCalls, order }
}

async function runSpy(
  mode: "shadow" | "enforce",
  command: string,
  messages: unknown[] = [],
  options: SpyOptions = {},
  fetchFn: FetchFn = failingFetch(),
): Promise<{ harness: SpyHarness; decision: Record<string, unknown> }> {
  const path = `/tmp/calibrated-access-dispatch-${crypto.randomUUID()}.jsonl`
  const harness = makeSpyHarness(messages, options)
  const config = parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode, diagnosticsPath: path })
  await reviewAndReply(
    harness.context,
    harness.client,
    config,
    { ...request, resources: [command] },
    new SessionApprovalCache(),
    performance.now(),
    new AbortController().signal,
    fetchFn,
  )
  const decision = JSON.parse(readFileSync(path, "utf-8").trim().split("\n").pop()!)
  unlinkSync(path)
  return { harness, decision }
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
      user_prohibited: { score: 4, confidence: 0.4 },
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

async function runCommand(
  mode: "shadow" | "enforce",
  command: string,
  fetchFn: FetchFn,
  messages: unknown[] = [],
): Promise<Harness> {
  const harness = makeHarness(messages)
  const config = parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode })
  await reviewAndReply(
    harness.context,
    harness.client,
    config,
    { ...request, resources: [command] },
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

async function runCommandWithDiagnostics(
  mode: "shadow" | "enforce",
  command: string,
  fetchFn: FetchFn,
  messages: unknown[] = [],
): Promise<{ harness: Harness; decision: Record<string, unknown> }> {
  const path = `/tmp/calibrated-access-dispatch-${crypto.randomUUID()}.jsonl`
  const harness = makeHarness(messages)
  const config = parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode, diagnosticsPath: path })
  await reviewAndReply(
    harness.context,
    harness.client,
    config,
    { ...request, resources: [command] },
    new SessionApprovalCache(),
    performance.now(),
    new AbortController().signal,
    fetchFn,
  )
  const decision = JSON.parse(readFileSync(path, "utf-8").trim().split("\n").pop()!)
  unlinkSync(path)
  return { harness, decision }
}

describe("dispatch — diagnostics usage/cost", () => {
  test("records the model's usage and cost on the decision event", async () => {
    const response = { ...systemOneBody(), usage: { input_tokens: 878, output_tokens: 125 }, cost: null }
    const { decision } = await runWithDiagnostics("shadow", okFetch(response))
    expect(decision.event).toBe("decision")
    expect(decision.source).toBe("typesafe")
    expect((decision.usage as Record<string, unknown>).input_tokens).toBe(878)
    expect((decision.usage as Record<string, unknown>).output_tokens).toBe(125)
    expect(decision.cost).toBeNull()
  })

  test("omits usage/cost when the model call returns none", async () => {
    const { decision } = await runWithDiagnostics("shadow", okFetch(systemOneBody()))
    expect("usage" in decision).toBe(false)
    expect("cost" in decision).toBe(false)
  })

  test("does not add usage/cost to a policy-sourced decision", async () => {
    const { decision } = await runCommandWithDiagnostics("shadow", "rm -rf /", okFetch(systemOneBody()))
    expect(decision.source).toBe("policy")
    expect("usage" in decision).toBe(false)
    expect("cost" in decision).toBe(false)
  })

  test("records command text, promptVersion, and findings on a model decision", async () => {
    const { decision } = await runCommandWithDiagnostics("enforce", "cat .env", okFetch(systemOneBody()))
    expect(decision.command).toBe("cat .env")
    expect(decision.promptVersion).toBe("3")
    const findings = decision.findings as Array<Record<string, unknown>>
    expect(findings.map((finding) => finding.code)).toEqual(["secret_exposure"])
    expect(findings[0]!.severity).toBe("caution")
  })
})

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

  test("fail-closed: resumes with an intact continuation payload when the rater fails", async () => {
    const { replies, resumes } = await run("enforce", failingFetch())
    expect(replies[0]!.reply).toBe("reject")
    expect(resumes).toHaveLength(1)
    expect(resumes[0]!.sessionID).toBe("sess1")
    expect(resumes[0]!.reason).toContain("Permission review failed")
    expect(resumes[0]!.reason).not.toContain("undefined")
    expect(resumes[0]!.reason).not.toContain("Safer alternatives:")
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

  test("never caches a shadow-mode decision", async () => {
    const harness = makeHarness()
    const cache = new SessionApprovalCache()
    const scoped: PermissionRequest = { ...request, always: ["bash:echo hi > /tmp/x"] }
    const config = parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode: "shadow" })

    await reviewAndReply(
      harness.context,
      harness.client,
      config,
      scoped,
      cache,
      performance.now(),
      new AbortController().signal,
      okFetch(systemOneBody({ destructive: { score: 4, confidence: 0.9 } })),
    )
    expect(harness.replies[0]!.reply).toBe("once")
    expect(cache.has("root1", scoped.action, scoped.always)).toBe(false)
  })
})

describe("dispatch — deterministic secret exposure", () => {
  test("enforce mode rejects with alternatives in the message and continuation", async () => {
    const { replies, resumes } = await runCommand("enforce", "echo $API_KEY", okFetch(systemOneBody()))
    expect(replies[0]!.reply).toBe("reject")
    expect(replies[0]!.message).toContain("API_KEY")
    expect(replies[0]!.message).toContain("Safer alternatives:")
    expect(replies[0]!.message).toContain("- Use gh auth login / git credential fill instead of inlining tokens.")
    expect(resumes[0]!.reason).toContain("Safer alternatives:")
  })

  test("enforce mode allows routine commands through the model (no allow-list)", async () => {
    const { replies } = await runCommand("enforce", "git status", okFetch(systemOneBody()))
    expect(replies[0]!.reply).toBe("once")
  })

  test("passes the last assistant agent as routing to resumeAfterDenial", async () => {
    const messages = [{ info: { role: "assistant", agent: "planner" }, parts: [] }]
    const { resumes } = await runCommand("enforce", "sudo apt update", okFetch(systemOneBody({ destructive: { score: 4, confidence: 0.9 } })), messages)
    expect(resumes).toHaveLength(1)
    expect(resumes[0]!.routing).toEqual({ agent: "planner" })
  })

  test("derives routing from the latest user message", async () => {
    const messages = [
      { info: { role: "user", agent: "planner", model: { providerID: "anthropic", modelID: "claude-sonnet", variant: "high" } }, parts: [] },
    ]
    const { resumes } = await runCommand("enforce", "sudo apt update", okFetch(systemOneBody({ destructive: { score: 4, confidence: 0.9 } })), messages)
    expect(resumes).toHaveLength(1)
    expect(resumes[0]!.routing).toEqual({
      agent: "planner",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
      variant: "high",
    })
  })
})

describe("dispatch — shadow mode deterministic policy", () => {
  test("allows secret exposure through but toasts what would have been blocked", async () => {
    const { replies, toasts } = await runCommand("shadow", "echo $API_KEY", okFetch(systemOneBody()))
    expect(replies[0]!.reply).toBe("once")
    expect(replies[0]!.message).toBeUndefined()
    expect(toasts.some((t) => /shadow mode/i.test(t.message) && /secret_exposure/.test(t.message))).toBe(true)
  })

  test("allows secret-file reads through but toasts what would have been blocked", async () => {
    const { replies, toasts } = await runCommand("shadow", "cat .env", okFetch(systemOneBody()))
    expect(replies[0]!.reply).toBe("once")
    expect(replies[0]!.message).toBeUndefined()
    expect(toasts.some((t) => /shadow mode/i.test(t.message) && /secret_exposure/.test(t.message))).toBe(true)
  })

  test("still enforces catastrophic deletes in shadow mode", async () => {
    const { replies } = await runCommand("shadow", "rm -rf /", okFetch(systemOneBody()))
    expect(replies[0]!.reply).toBe("reject")
    expect(replies[0]!.message).toContain("catastrophic")
  })

  test("still enforces explicit user prohibition in shadow mode", async () => {
    const messages = [{ type: "user", text: "Run it, but I explicitly prohibit `touch /tmp/example`." }]
    const { replies } = await runCommand("shadow", "touch /tmp/example", okFetch(systemOneBody()), messages)
    expect(replies[0]!.reply).toBe("reject")
    expect(replies[0]!.message).toContain("prohibit")
  })
})

describe("dispatch — user_prohibited signal", () => {
  const prohibitedBody = () => okFetch(systemOneBody({ user_prohibited: { score: 3, confidence: 0.9 } }))

  test("enforce mode rejects and offers staging alternatives in the reply and continuation", async () => {
    const { replies, resumes } = await runCommand("enforce", "git add .", prohibitedBody())
    expect(replies[0]!.reply).toBe("reject")
    expect(replies[0]!.message).toContain("user_prohibited")
    expect(replies[0]!.message).toContain("Safer alternatives:")
    expect(replies[0]!.message).toContain("- Stage files individually (git add <path>) after confirming none are secret-bearing.")
    expect(resumes[0]!.reason).toContain("Safer alternatives:")
    expect(resumes[0]!.reason).toContain("Run git status first and add only the intended paths.")
  })

  test("shadow mode logs but passes", async () => {
    const { replies, toasts } = await runCommand("shadow", "git add .", prohibitedBody())
    expect(replies[0]!.reply).toBe("once")
    expect(replies[0]!.message).toBeUndefined()
    expect(toasts.some((t) => /shadow mode: would have blocked/i.test(t.message) && /user_prohibited/.test(t.message))).toBe(true)
  })
})

describe("dispatch — fast-deny routes resume after replying", () => {
  test("replies before fetching messages, then resumes with routing from the latest user message", async () => {
    const messages = [
      {
        info: { role: "user", agent: "builder", model: { providerID: "anthropic", modelID: "claude-sonnet", variant: "high" } },
        parts: [],
      },
    ]
    const { harness, decision } = await runSpy("enforce", "rm -rf /", messages)
    expect(harness.rootCalls()).toBe(0)
    expect(harness.listCalls()).toBe(1)
    expect(harness.order.indexOf("reply")).toBeLessThan(harness.order.indexOf("messages"))
    expect(harness.replies[0]!.reply).toBe("reject")
    expect(harness.replies[0]!.message).toContain("catastrophic")
    expect(harness.resumes).toHaveLength(1)
    expect(harness.resumes[0]!.routing).toEqual({
      agent: "builder",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
      variant: "high",
    })
    expect(decision.event).toBe("decision")
    expect(decision.source).toBe("policy")
    expect(decision.reasonCode).toBe("catastrophic_delete")
    expect(decision.command).toBe("rm -rf /")
    expect(decision.promptVersion).toBe("3")
  })

  test("falls back to the last assistant agent when no user routing is present", async () => {
    const messages = [{ info: { role: "assistant", agent: "planner" }, parts: [] }]
    const { harness } = await runSpy("enforce", "rm -rf /", messages)
    expect(harness.rootCalls()).toBe(0)
    expect(harness.listCalls()).toBe(1)
    expect(harness.replies[0]!.reply).toBe("reject")
    expect(harness.resumes).toHaveLength(1)
    expect(harness.resumes[0]!.routing).toEqual({ agent: "planner" })
  })

  test("still resumes without routing when the messages fetch fails", async () => {
    const { harness } = await runSpy("enforce", "rm -rf /", [], { failMessages: true })
    expect(harness.rootCalls()).toBe(0)
    expect(harness.listCalls()).toBe(1)
    expect(harness.replies[0]!.reply).toBe("reject")
    expect(harness.resumes).toHaveLength(1)
    expect(harness.resumes[0]!.routing).toEqual({})
  })

  test("shadow mode sends a secret exposure finding to the judge and toasts the would-ask", async () => {
    const { harness, decision } = await runSpy("shadow", "echo $API_KEY", [], {}, okFetch(systemOneBody()))
    expect(harness.rootCalls()).toBe(1)
    expect(harness.listCalls()).toBe(1)
    expect(harness.replies[0]!.reply).toBe("once")
    expect(harness.replies[0]!.message).toBeUndefined()
    expect(harness.resumes).toHaveLength(0)
    expect(harness.toasts.some((t) => /shadow mode/i.test(t.message) && /secret_exposure/.test(t.message))).toBe(true)
    expect(decision.source).toBe("typesafe")
    expect(decision.reasonCode).toBe("shadow_ask")
    const findings = decision.findings as Array<Record<string, unknown>>
    expect(findings[0]!.code).toBe("secret_exposure")
  })

  test("still enforces a fast-deny catastrophic delete in shadow mode and routes the resume", async () => {
    const messages = [{ info: { role: "user", agent: "planner" }, parts: [] }]
    const { harness, decision } = await runSpy("shadow", "rm -rf /", messages)
    expect(harness.rootCalls()).toBe(0)
    expect(harness.listCalls()).toBe(1)
    expect(harness.replies[0]!.reply).toBe("reject")
    expect(harness.resumes).toHaveLength(1)
    expect(harness.resumes[0]!.routing).toEqual({ agent: "planner" })
    expect(decision.reasonCode).toBe("catastrophic_delete")
  })
})

describe("dispatch — sessionApprovals gating", () => {
  const scoped = (): PermissionRequest => ({ ...request, always: ["bash:echo hi > /tmp/x"] })

  test("does not consult the session cache when sessionApprovals is false", async () => {
    const harness = makeHarness()
    const cache = new SessionApprovalCache()
    const req = scoped()
    cache.add("root1", req.action, req.always)
    const config = parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode: "enforce", sessionApprovals: false })
    await reviewAndReply(
      harness.context,
      harness.client,
      config,
      req,
      cache,
      performance.now(),
      new AbortController().signal,
      okFetch(systemOneBody({ destructive: { score: 4, confidence: 0.9 } })),
    )
    expect(harness.replies[0]!.reply).toBe("reject")
  })

  test("does not write to the session cache when sessionApprovals is false", async () => {
    const harness = makeHarness()
    const cache = new SessionApprovalCache()
    const req = scoped()
    const config = parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode: "enforce", sessionApprovals: false })
    await reviewAndReply(
      harness.context,
      harness.client,
      config,
      req,
      cache,
      performance.now(),
      new AbortController().signal,
      okFetch(systemOneBody()),
    )
    expect(harness.replies[0]!.reply).toBe("once")
    expect(cache.has("root1", req.action, req.always)).toBe(false)
  })

  test("reuses and records approvals when sessionApprovals is true", async () => {
    const harness = makeHarness()
    const cache = new SessionApprovalCache()
    const req = scoped()
    const config = parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode: "enforce", sessionApprovals: true })

    await reviewAndReply(
      harness.context,
      harness.client,
      config,
      req,
      cache,
      performance.now(),
      new AbortController().signal,
      okFetch(systemOneBody()),
    )
    expect(cache.has("root1", req.action, req.always)).toBe(true)

    await reviewAndReply(
      harness.context,
      harness.client,
      config,
      req,
      cache,
      performance.now(),
      new AbortController().signal,
      failingFetch(),
    )
    expect(harness.replies[1]!.reply).toBe("once")
  })
})

describe("dispatch — headless auto-reject race", () => {
  async function reviewResolvedMidFlight(
    req: PermissionRequest,
    cache: SessionApprovalCache,
  ): Promise<{ harness: Harness; lines: Record<string, unknown>[] }> {
    const path = `/tmp/calibrated-access-dispatch-${crypto.randomUUID()}.jsonl`
    const config = parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode: "enforce", diagnosticsPath: path })
    const harness = makeHarness()
    const controller = new AbortController()

    let releaseModel: (() => void) | undefined
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve
    })
    let modelStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      modelStarted = resolve
    })
    const gatedFetch = (async () => {
      modelStarted!()
      await modelGate
      return { ok: true, status: 200, json: async () => systemOneBody(), text: async () => "" }
    }) as unknown as FetchFn

    const review = reviewAndReply(
      harness.context,
      harness.client,
      config,
      req,
      cache,
      performance.now(),
      controller.signal,
      gatedFetch,
    )

    await started
    controller.abort("permission resolved")
    releaseModel!()
    await review

    const lines = readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    unlinkSync(path)
    return { harness, lines }
  }

  test("records the completed review when the request is resolved before the reply", async () => {
    const { harness, lines } = await reviewResolvedMidFlight(request, new SessionApprovalCache())

    const decision = lines.find((line) => line.event === "decision")
    expect(decision).toBeDefined()
    expect(decision!.source).toBe("typesafe")
    expect(decision!.reasonCode).toBe("signals_below_threshold")
    expect(harness.replies).toHaveLength(0)
  })

  test("does not cache an approval for a request resolved before the reply", async () => {
    const req: PermissionRequest = { ...request, always: ["bash:echo hi > /tmp/x"] }
    const cache = new SessionApprovalCache()
    const { harness } = await reviewResolvedMidFlight(req, cache)

    expect(cache.has("root1", req.action, req.always)).toBe(false)
    expect(harness.replies).toHaveLength(0)
  })
})

describe("dispatch — block-with-appeal justification", () => {
  const continuation = () => ({
    type: "user",
    text: "[Calibrated Access] The requested action was blocked: risky (blocked: gh pr create). Do not retry the exact blocked action.",
  })
  const justification =
    "The user asked to create the PR; the body is the tested diff summary; the destination is the repo's own remote."
  const blockBody = () =>
    systemOneBody({
      destructive: { score: 4, confidence: 0.9 },
      user_requested: { score: 4, confidence: 0.9 },
    })

  async function runWithCache(
    messages: unknown[],
    cache: SessionApprovalCache,
    fetchFn: FetchFn,
    command = "gh pr create",
  ): Promise<Harness> {
    const harness = makeHarness(messages)
    const config = parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode: "enforce" })
    await reviewAndReply(
      harness.context,
      harness.client,
      config,
      { ...request, resources: [command] },
      cache,
      performance.now(),
      new AbortController().signal,
      fetchFn,
    )
    return harness
  }

  test("a justified retry downgrades a block to an ask (never a silent allow)", async () => {
    const { replies } = await runWithCache(
      [continuation(), { type: "user", text: justification }],
      new SessionApprovalCache(),
      okFetch(blockBody()),
    )
    expect(replies[0]!.reply).toBe("reject")
    expect(replies[0]!.message).toMatch(/ask|confirm/i)
    expect(replies[0]!.message).toMatch(/justif/i)
  })

  test("a retry without a justification stays blocked", async () => {
    const { replies } = await runWithCache(
      [continuation()],
      new SessionApprovalCache(),
      okFetch(blockBody()),
    )
    expect(replies[0]!.reply).toBe("reject")
    expect(replies[0]!.message).toMatch(/meets the block threshold/i)
    expect(replies[0]!.message).not.toMatch(/Justification supported/i)
  })

  test("a justified retry never bypasses a user_prohibited block", async () => {
    const { replies } = await runWithCache(
      [continuation(), { type: "user", text: justification }],
      new SessionApprovalCache(),
      okFetch(
        systemOneBody({
          user_prohibited: { score: 4, confidence: 0.9 },
          user_requested: { score: 4, confidence: 0.9 },
        }),
      ),
    )
    expect(replies[0]!.reply).toBe("reject")
    expect(replies[0]!.message).toMatch(/user_prohibited|prohibit/i)
  })

  test("a justified retry never bypasses a deterministic finding floor", async () => {
    const { replies } = await runWithCache(
      [continuation(), { type: "user", text: justification }],
      new SessionApprovalCache(),
      okFetch(blockBody()),
      "cat .env",
    )
    expect(replies[0]!.reply).toBe("reject")
    expect(replies[0]!.message).toMatch(/block/i)
  })

  test("one appeal per request: a second retry blocks outright without another model call", async () => {
    const cache = new SessionApprovalCache()
    const first = await runWithCache([continuation(), { type: "user", text: justification }], cache, okFetch(blockBody()))
    expect(first.replies[0]!.reply).toBe("reject")

    let modelCalls = 0
    const second = await runWithCache(
      [continuation(), { type: "user", text: justification }],
      cache,
      (async () => {
        modelCalls += 1
        throw new Error("model must not be called for an exhausted appeal")
      }) as unknown as FetchFn,
    )
    expect(modelCalls).toBe(0)
    expect(second.replies[0]!.reply).toBe("reject")
    expect(second.replies[0]!.message).toMatch(/appeal/i)
  })

  test("one appeal per request: a second unjustified retry also blocks outright", async () => {
    const cache = new SessionApprovalCache()
    await runWithCache([continuation(), { type: "user", text: justification }], cache, okFetch(blockBody()))

    let modelCalls = 0
    const second = await runWithCache(
      [continuation()],
      cache,
      (async () => {
        modelCalls += 1
        throw new Error("model must not be called for an exhausted appeal")
      }) as unknown as FetchFn,
    )
    expect(modelCalls).toBe(0)
    expect(second.replies[0]!.reply).toBe("reject")
    expect(second.replies[0]!.message).toMatch(/appeal/i)
  })

  test("records promptVersion 3 on a justified decision event", async () => {
    const path = `/tmp/calibrated-access-dispatch-${crypto.randomUUID()}.jsonl`
    const harness = makeHarness([continuation(), { type: "user", text: justification }])
    const config = parseConfig({ provider: "typesafe", systemOneApiKey: "sk-test", mode: "enforce", diagnosticsPath: path })
    await reviewAndReply(
      harness.context,
      harness.client,
      config,
      { ...request, resources: ["gh pr create"] },
      new SessionApprovalCache(),
      performance.now(),
      new AbortController().signal,
      okFetch(blockBody()),
    )
    const decision = JSON.parse(readFileSync(path, "utf-8").trim().split("\n").pop()!)
    unlinkSync(path)
    expect(decision.promptVersion).toBe("3")
    expect(decision.decision).toBe("deny")
    expect(decision.reasonCode).toBe("signal_ask_destructive")
  })
})
