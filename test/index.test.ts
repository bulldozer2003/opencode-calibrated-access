import { describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "fs"
import { installReviewer } from "../src/reviewer.ts"
import type { ReviewerClient, RuntimeContext } from "../src/types.ts"

type Handler = (event: unknown) => void
type ReplyInput = Parameters<ReviewerClient["reply"]>[0]

interface MockRuntime {
  context: RuntimeContext
  emit(type: string, event: unknown): Promise<void>
  registered(): string[]
  unregistered(): string[]
}

function makeRuntime(
  client: unknown = {},
  options: Record<string, unknown> = {},
  messages: unknown[] = [],
  directory?: string,
): MockRuntime {
  const handlers = new Map<string, Handler[]>()
  const registered: string[] = []
  const unregistered: string[] = []

  const context: RuntimeContext = {
    options,
    client,
    ...(directory ? { directory } : {}),
    data: {
      on(type, handler) {
        registered.push(type)
        const list = handlers.get(type) ?? []
        list.push(handler)
        handlers.set(type, list)
        return () => {
          unregistered.push(type)
          handlers.set(type, (handlers.get(type) ?? []).filter((item) => item !== handler))
        }
      },
      session: {
        root: () => "root1",
        get: () => undefined,
        message: { list: () => messages, get: () => undefined, sync: async () => {} },
        permission: { list: () => undefined, sync: async () => {} },
      },
    },
  }

  return {
    context,
    async emit(type, event) {
      await Promise.all((handlers.get(type) ?? []).map((handler) => handler(event)))
    },
    registered: () => [...registered],
    unregistered: () => [...unregistered],
  }
}

function askedEvent(id: string, command: string) {
  return {
    type: "permission.v2.asked",
    properties: { id, sessionID: "sess1", action: "bash", resources: [command], always: [] },
  }
}

function diagPath(): string {
  return `/tmp/calibrated-access-resume-${crypto.randomUUID()}.jsonl`
}

function readEvents(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

async function waitForEvent(path: string, event: string): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < 200; i++) {
    const events = readEvents(path)
    if (events.some((item) => item.event === event)) return events
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${event} diagnostic`)
}

function probeResults(events: Array<Record<string, unknown>>): string[] {
  return events.filter((item) => item.event === "resume_probe").map((item) => String(item.result))
}

describe("installReviewer", () => {
  test("registers listeners for all permission events", () => {
    const runtime = makeRuntime()
    installReviewer(runtime.context, { client: { reply: async () => "replied" } })
    expect(runtime.registered().sort()).toEqual(
      ["permission.v2.replied", "permission.replied", "permission.v2.asked", "permission.asked", "permission.updated"].sort(),
    )
  })

  test("teardown unregisters every listener it registered", () => {
    const runtime = makeRuntime()
    const dispose = installReviewer(runtime.context, { client: { reply: async () => "replied" } })
    dispose()
    expect(runtime.unregistered().sort()).toEqual(runtime.registered().sort())
  })

  test("replies once for a routine command routed through the injected client", async () => {
    const runtime = makeRuntime()
    const replies: ReplyInput[] = []
    installReviewer(runtime.context, {
      client: {
        async reply(input) {
          replies.push(input)
          return "replied"
        },
      },
    })
    await runtime.emit("permission.v2.asked", askedEvent("req1", "git status"))
    expect(replies).toHaveLength(1)
    expect(replies[0]!.reply).toBe("once")
    expect(replies[0]!.requestID).toBe("req1")
  })

  test("ignores a duplicate asked event for an in-flight request", async () => {
    const runtime = makeRuntime()
    const replies: ReplyInput[] = []
    installReviewer(runtime.context, {
      client: {
        async reply(input) {
          replies.push(input)
          return "replied"
        },
      },
    })
    const event = askedEvent("req-dup", "git status")
    await Promise.all([
      runtime.emit("permission.v2.asked", event),
      runtime.emit("permission.v2.asked", event),
    ])
    expect(replies).toHaveLength(1)
  })

  test("resumes a denied session with the continuation message and alternatives", async () => {
    const prompts: Array<{ path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }> = []
    const runtime = makeRuntime({
      session: {
        async promptAsync(input: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }) {
          prompts.push(input)
        },
      },
    })
    installReviewer(runtime.context, { client: { reply: async () => "replied" } })
    await runtime.emit("permission.v2.asked", askedEvent("req-secret", "echo $API_KEY"))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.path.id).toBe("sess1")
    const text = prompts[0]!.body.parts.map((part) => part.text).join("\n")
    expect(text).toContain("[Calibrated Access]")
    expect(text).toContain("expose a secret")
    expect(text).toContain("Safer alternatives:")
    expect(text).toContain("- Use gh auth login")
  })

  test("falls back to session.prompt when promptAsync is unavailable", async () => {
    const prompts: Array<{ path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }> = []
    const runtime = makeRuntime({
      session: {
        async prompt(input: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }) {
          prompts.push(input)
        },
      },
    })
    installReviewer(runtime.context, { client: { reply: async () => "replied" } })
    await runtime.emit("permission.v2.asked", askedEvent("req-secret-fallback", "echo $API_KEY"))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.body.parts[0]!.text).toContain("Safer alternatives:")
  })

  test("falls back to client.permission.reply when no client override is supplied", async () => {
    const replies: ReplyInput[] = []
    const runtime = makeRuntime({
      permission: {
        async reply(input: { requestID: string; reply: string }) {
          replies.push({ sessionID: "sess1", requestID: input.requestID, reply: input.reply, protocol: "v2" } as ReplyInput)
        },
      },
    })
    installReviewer(runtime.context)
    await runtime.emit("permission.v2.asked", askedEvent("req-fb", "git status"))
    expect(replies).toHaveLength(1)
    expect(replies[0]!.requestID).toBe("req-fb")
  })

  test("retries a resumed prompt once after an SDK error result and logs ok at attempt 2", async () => {
    const path = diagPath()
    const calls: unknown[] = []
    let count = 0
    const runtime = makeRuntime(
      {
        session: {
          async promptAsync(input: unknown) {
            calls.push(input)
            count++
            if (count === 1) return { data: undefined, error: { message: "session busy", status: 409 } }
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-resume-a", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    expect(calls).toHaveLength(2)
    const resume = events.find((item) => item.event === "resume")!
    expect(resume.ok).toBe(true)
    expect(resume.attempt).toBe(2)
    expect(resume.sessionID).toBe("sess1")
    rmSync(path, { force: true })
  })

  test("logs a failed resume with sanitized error detail after two error results", async () => {
    const path = diagPath()
    const calls: unknown[] = []
    const runtime = makeRuntime(
      {
        session: {
          async promptAsync(input: unknown) {
            calls.push(input)
            return { data: undefined, error: { message: "session busy", status: 409 } }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-resume-b", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    expect(calls).toHaveLength(2)
    const resume = events.find((item) => item.event === "resume")!
    expect(resume.ok).toBe(false)
    expect(resume.attempt).toBe(2)
    expect(String(resume.error)).toContain("session busy")
    expect(String(resume.error)).toContain("409")
    rmSync(path, { force: true })
  })

  test("logs ok at attempt 1 when the resumed prompt succeeds first try", async () => {
    const path = diagPath()
    const calls: unknown[] = []
    const runtime = makeRuntime(
      {
        session: {
          async promptAsync(input: unknown) {
            calls.push(input)
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-resume-c", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    expect(calls).toHaveLength(1)
    const resume = events.find((item) => item.event === "resume")!
    expect(resume.ok).toBe(true)
    expect(resume.attempt).toBe(1)
    rmSync(path, { force: true })
  })

  test("catches a transport throw, retries, and logs ok at attempt 2", async () => {
    const path = diagPath()
    const calls: unknown[] = []
    let count = 0
    const runtime = makeRuntime(
      {
        session: {
          async promptAsync(input: unknown) {
            calls.push(input)
            count++
            if (count === 1) throw new Error("ECONNRESET")
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-resume-d", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    expect(calls).toHaveLength(2)
    const resume = events.find((item) => item.event === "resume")!
    expect(resume.ok).toBe(true)
    expect(resume.attempt).toBe(2)
    rmSync(path, { force: true })
  })

  test("waits for the session to go idle before resuming and records waitMs", async () => {
    const path = diagPath()
    const sequence: string[] = []
    let statusCount = 0
    const runtime = makeRuntime(
      {
        session: {
          async status() {
            sequence.push("status")
            statusCount++
            return { data: { sess1: { type: statusCount === 1 ? "busy" : "idle" } }, error: undefined }
          },
          async promptAsync() {
            sequence.push("prompt")
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-idle-a", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    expect(sequence.slice(0, 3)).toEqual(["status", "status", "prompt"])
    const resume = events.find((item) => item.event === "resume")!
    expect(resume.ok).toBe(true)
    expect(resume.attempt).toBe(1)
    expect(Number(resume.waitMs)).toBeGreaterThan(0)
    rmSync(path, { force: true })
  })

  test("fail-opens to the prompt when the session never goes idle", async () => {
    const path = diagPath()
    const calls: unknown[] = []
    const runtime = makeRuntime(
      {
        session: {
          async status() {
            return { data: { sess1: { type: "busy" } }, error: undefined }
          },
          async promptAsync(input: unknown) {
            calls.push(input)
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, {
      client: { reply: async () => "replied" },
      sleep: async () => {},
      idleSleep: async () => {},
      idleIntervalMs: 250,
      idleMaxWaitMs: 250,
    })
    await runtime.emit("permission.v2.asked", askedEvent("req-idle-b", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    expect(calls).toHaveLength(1)
    const resume = events.find((item) => item.event === "resume")!
    expect(resume.ok).toBe(true)
    expect(resume.failOpen).toBe(true)
    rmSync(path, { force: true })
  })

  test("treats a missing status method or an absent entry as idle; failing status fail-opens", async () => {
    const cases: Array<{ extra: Record<string, unknown>; failOpen: boolean }> = [
      { extra: {}, failOpen: false },
      { extra: { async status() { throw new Error("status unavailable") } }, failOpen: true },
      { extra: { async status() { return { data: { other: { type: "busy" } }, error: undefined } } }, failOpen: false },
    ]
    for (const { extra, failOpen } of cases) {
      const path = diagPath()
      const calls: unknown[] = []
      const session = {
        ...extra,
        async promptAsync(input: unknown) {
          calls.push(input)
          return { data: { ok: true } }
        },
      }
      const runtime = makeRuntime({ session }, { diagnosticsPath: path })
      installReviewer(runtime.context, {
        client: { reply: async () => "replied" },
        sleep: async () => {},
        idleSleep: async () => {},
        idleIntervalMs: 250,
        idleMaxWaitMs: 250,
      })
      await runtime.emit("permission.v2.asked", askedEvent(`req-idle-c-${crypto.randomUUID()}`, "echo $API_KEY"))
      const events = await waitForEvent(path, "resume")
      expect(calls).toHaveLength(1)
      const resume = events.find((item) => item.event === "resume")!
      expect(resume.ok).toBe(true)
      expect(Boolean(resume.failOpen)).toBe(failOpen)
      rmSync(path, { force: true })
    }
  })

  test("waits for idle again before the retry attempt after an SDK error", async () => {
    const path = diagPath()
    let statusCount = 0
    let promptCount = 0
    const runtime = makeRuntime(
      {
        session: {
          async status() {
            statusCount++
            if (statusCount === 1) return { data: { sess1: { type: "idle" } }, error: undefined }
            return { data: { sess1: { type: statusCount === 2 ? "busy" : "idle" } }, error: undefined }
          },
          async promptAsync() {
            promptCount++
            if (promptCount === 1) return { data: undefined, error: { message: "session busy", status: 409 } }
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-idle-d", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    expect(promptCount).toBe(2)
    const resume = events.find((item) => item.event === "resume")!
    expect(resume.ok).toBe(true)
    expect(resume.attempt).toBe(2)
    expect(Number(resume.waitMs)).toBeGreaterThan(0)
    rmSync(path, { force: true })
  })

  test("logs a resume_probe for each status poll while waiting for idle", async () => {
    const path = diagPath()
    let statusCount = 0
    const runtime = makeRuntime(
      {
        session: {
          async status() {
            statusCount++
            return { data: { sess1: { type: statusCount === 1 ? "busy" : "idle" } }, error: undefined }
          },
          async promptAsync() {
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-probe-a", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    expect(probeResults(events)).toEqual(["busy", "idle"])
    const probes = events.filter((item) => item.event === "resume_probe")
    expect(probes[0]!.sessionID).toBe("sess1")
    expect(probes[0]!.attempt).toBe(1)
    expect(probes[1]!.attempt).toBe(2)
    rmSync(path, { force: true })
  })

  test("treats an absent status entry as idle and prompts immediately without waiting", async () => {
    const path = diagPath()
    const calls: unknown[] = []
    const runtime = makeRuntime(
      {
        session: {
          async status() {
            return { data: {}, error: undefined }
          },
          async promptAsync(input: unknown) {
            calls.push(input)
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, {
      client: { reply: async () => "replied" },
      sleep: async () => {},
      idleSleep: async () => {},
      idleIntervalMs: 250,
      idleMaxWaitMs: 10000,
    })
    await runtime.emit("permission.v2.asked", askedEvent("req-probe-b", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    expect(calls).toHaveLength(1)
    const probes = probeResults(events)
    expect(probes).toEqual(["absent"])
    const resume = events.find((item) => item.event === "resume")!
    expect(resume.ok).toBe(true)
    expect(resume.failOpen).toBe(false)
    expect(Number(resume.waitMs)).toBe(0)
    rmSync(path, { force: true })
  })

  test("keeps retrying a failing status probe and fail-opens at timeout", async () => {
    const path = diagPath()
    const calls: unknown[] = []
    const runtime = makeRuntime(
      {
        session: {
          async status() {
            throw new Error("status unavailable")
          },
          async promptAsync(input: unknown) {
            calls.push(input)
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, {
      client: { reply: async () => "replied" },
      sleep: async () => {},
      idleSleep: async () => {},
      idleIntervalMs: 250,
      idleMaxWaitMs: 250,
    })
    await runtime.emit("permission.v2.asked", askedEvent("req-probe-c", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    expect(calls).toHaveLength(1)
    const probes = events.filter((item) => item.event === "resume_probe")
    expect(probes.length).toBeGreaterThanOrEqual(1)
    expect(probes.every((item) => item.result === "error")).toBe(true)
    expect(String(probes[0]!.error)).toContain("status unavailable")
    const resume = events.find((item) => item.event === "resume")!
    expect(resume.ok).toBe(true)
    expect(resume.failOpen).toBe(true)
    rmSync(path, { force: true })
  })

  test("records started:true when the continuation message appears in the session message list", async () => {
    const path = diagPath()
    const messageCalls: unknown[] = []
    const runtime = makeRuntime(
      {
        session: {
          async promptAsync() {
            return { data: { ok: true } }
          },
          async messages(input: unknown) {
            messageCalls.push(input)
            return {
              data: [
                {
                  info: { role: "user" },
                  parts: [
                    {
                      type: "text",
                      text: "[Calibrated Access] The requested action was blocked: expose a secret (blocked: cat .env). Do not retry the exact blocked action.",
                    },
                  ],
                },
              ],
            }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-start-a", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    const resume = events.find((item) => item.event === "resume")!
    expect(resume.ok).toBe(true)
    expect(resume.started).toBe(true)
    expect(messageCalls[0]).toEqual({ path: { id: "sess1" } })
    rmSync(path, { force: true })
  })

  test("records started:false and a note when the continuation message never appears", async () => {
    const path = diagPath()
    const runtime = makeRuntime(
      {
        session: {
          async promptAsync() {
            return { data: { ok: true } }
          },
          async messages() {
            return { data: [{ info: { role: "assistant" }, parts: [] }] }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-start-b", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    const resume = events.find((item) => item.event === "resume")!
    expect(resume.ok).toBe(true)
    expect(resume.started).toBe(false)
    expect(String(resume.note)).toContain("no turn started")
    rmSync(path, { force: true })
  })

  test("omits started when the session message list cannot be fetched", async () => {
    const path = diagPath()
    const runtime = makeRuntime(
      {
        session: {
          async promptAsync() {
            return { data: { ok: true } }
          },
          async messages() {
            throw new Error("messages unavailable")
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-start-c", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    const resume = events.find((item) => item.event === "resume")!
    expect(resume.ok).toBe(true)
    expect("started" in resume).toBe(false)
    expect("note" in resume).toBe(false)
    rmSync(path, { force: true })
  })

  test("falls back to the last assistant agent when no user routing is present", async () => {
    const path = diagPath()
    const prompts: Array<{ path: { id: string }; body: { parts: unknown[]; agent?: string } }> = []
    const runtime = makeRuntime(
      {
        session: {
          async promptAsync(input: { path: { id: string }; body: { parts: unknown[]; agent?: string } }) {
            prompts.push(input)
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
      [
        { info: { role: "assistant", agent: "planner" }, parts: [] },
        { info: { role: "user" }, parts: [{ type: "text", text: "never run `touch /tmp/example`" }] },
      ],
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-agent", "touch /tmp/example"))
    await waitForEvent(path, "resume")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.body.agent).toBe("planner")
    rmSync(path, { force: true })
  })

  test("threads user-message routing (agent/model/variant) into the resume prompt body", async () => {
    const path = diagPath()
    const prompts: Array<{ path: { id: string }; body: { parts: unknown[]; agent?: string; model?: unknown; variant?: string } }> = []
    const runtime = makeRuntime(
      {
        session: {
          async promptAsync(input: { path: { id: string }; body: { parts: unknown[]; agent?: string; model?: unknown; variant?: string } }) {
            prompts.push(input)
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
      [
        {
          info: { role: "user", agent: "planner", model: { providerID: "anthropic", modelID: "claude-sonnet", variant: "high" } },
          parts: [{ type: "text", text: "never run `touch /tmp/example`" }],
        },
      ],
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-routing-a", "touch /tmp/example"))
    await waitForEvent(path, "resume")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.body.agent).toBe("planner")
    expect(prompts[0]!.body.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet" })
    expect(prompts[0]!.body.variant).toBe("high")
    rmSync(path, { force: true })
  })

  test("routes a fast-deny resume from one message fetch without resolving the root session", async () => {
    const path = diagPath()
    const prompts: Array<{ path: { id: string }; body: { parts: unknown[]; agent?: string; model?: unknown } }> = []
    const runtime = makeRuntime(
      {
        session: {
          async promptAsync(input: { path: { id: string }; body: { parts: unknown[]; agent?: string; model?: unknown } }) {
            prompts.push(input)
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
      [
        {
          info: { role: "user", agent: "planner", model: { providerID: "anthropic", modelID: "claude-sonnet" } },
          parts: [{ type: "text", text: "print the fake secret" }],
        },
      ],
    )
    let rootCalls = 0
    runtime.context.data.session.root = () => {
      rootCalls += 1
      return "root1"
    }
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-fast-routing", "echo $API_KEY"))
    await waitForEvent(path, "resume")
    expect(rootCalls).toBe(0)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.body.agent).toBe("planner")
    expect(prompts[0]!.body.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet" })
    rmSync(path, { force: true })
  })

  test("scopes the status probe and resume prompt with the context directory", async () => {
    const path = diagPath()
    const statusCalls: unknown[] = []
    const prompts: Array<{ query?: { directory: string }; body: { parts: unknown[] } }> = []
    const runtime = makeRuntime(
      {
        session: {
          async status(input: unknown) {
            statusCalls.push(input)
            return { data: { sess1: { type: "idle" } }, error: undefined }
          },
          async promptAsync(input: { query?: { directory: string }; body: { parts: unknown[] } }) {
            prompts.push(input)
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
      [],
      "proj-dir",
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-scope-a", "echo $API_KEY"))
    await waitForEvent(path, "resume")
    expect(statusCalls[0]).toEqual({ query: { directory: "proj-dir" } })
    expect(prompts[0]!.query).toEqual({ directory: "proj-dir" })
    rmSync(path, { force: true })
  })

  test("omits the directory query when the context has none", async () => {
    const path = diagPath()
    const statusCalls: unknown[] = []
    const prompts: Array<{ query?: { directory: string }; body: { parts: unknown[] } }> = []
    const runtime = makeRuntime(
      {
        session: {
          async status(input: unknown) {
            statusCalls.push(input)
            return { data: { sess1: { type: "idle" } }, error: undefined }
          },
          async promptAsync(input: { query?: { directory: string }; body: { parts: unknown[] } }) {
            prompts.push(input)
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-scope-b", "echo $API_KEY"))
    await waitForEvent(path, "resume")
    expect(statusCalls[0]).toEqual({})
    expect(prompts[0]!.query).toBeUndefined()
    rmSync(path, { force: true })
  })

  test("logs scoped:true on resume probes when the context is directory-scoped", async () => {
    const path = diagPath()
    const runtime = makeRuntime(
      {
        session: {
          async status() {
            return { data: { sess1: { type: "idle" } }, error: undefined }
          },
          async promptAsync() {
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
      [],
      "proj-dir",
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-scoped-a", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    const probes = events.filter((item) => item.event === "resume_probe")
    expect(probes.length).toBeGreaterThanOrEqual(1)
    expect(probes.every((item) => item.scoped === true)).toBe(true)
    rmSync(path, { force: true })
  })

  test("logs scoped:false on resume probes when the context has no directory", async () => {
    const path = diagPath()
    const runtime = makeRuntime(
      {
        session: {
          async status() {
            return { data: { sess1: { type: "idle" } }, error: undefined }
          },
          async promptAsync() {
            return { data: { ok: true } }
          },
        },
      },
      { diagnosticsPath: path },
    )
    installReviewer(runtime.context, { client: { reply: async () => "replied" }, sleep: async () => {}, idleSleep: async () => {} })
    await runtime.emit("permission.v2.asked", askedEvent("req-scoped-b", "echo $API_KEY"))
    const events = await waitForEvent(path, "resume")
    const probes = events.filter((item) => item.event === "resume_probe")
    expect(probes.length).toBeGreaterThanOrEqual(1)
    expect(probes.every((item) => item.scoped === false)).toBe(true)
    rmSync(path, { force: true })
  })

  test("logs the workspace directory in the plugin_started event", () => {
    const path = diagPath()
    const runtime = makeRuntime({}, { diagnosticsPath: path }, [], "proj-dir")
    installReviewer(runtime.context, { client: { reply: async () => "replied" } })
    const started = readEvents(path).find((item) => item.event === "plugin_started")!
    expect(started.directory).toBe("proj-dir")
    rmSync(path, { force: true })
  })

  test("logs directory:null in plugin_started when the context has no directory", () => {
    const path = diagPath()
    const runtime = makeRuntime({}, { diagnosticsPath: path })
    installReviewer(runtime.context, { client: { reply: async () => "replied" } })
    const started = readEvents(path).find((item) => item.event === "plugin_started")!
    expect(started.directory).toBeNull()
    rmSync(path, { force: true })
  })
})
