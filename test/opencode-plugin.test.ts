import { describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "fs"
import { CalibratedAccessPlugin } from "../src/index.ts"

interface ReplyCall {
  path: { id: string; permissionID: string }
  body: { response: string; message?: string }
}

interface MockClient {
  replies: ReplyCall[]
  sessionMessagesCalls: string[]
  session: {
    get(input: { path: { id: string } }): Promise<{ data: Record<string, unknown> }>
    messages(input: { path: { id: string } }): Promise<{ data: unknown[] }>
    promptAsync(input: unknown): Promise<void>
  }
  postSessionIdPermissionsPermissionId(input: ReplyCall): Promise<void>
}

function makeClient(options: { messages?: unknown[]; getGate?: Promise<void> } = {}): MockClient {
  const replies: ReplyCall[] = []
  const sessionMessagesCalls: string[] = []
  return {
    replies,
    sessionMessagesCalls,
    session: {
      async get(input) {
        if (options.getGate) await options.getGate
        return {
          data: {
            id: input.path.id,
            projectID: "project",
            directory: "/tmp",
            title: "mock",
            version: "1.0.0",
            time: { created: 0, updated: 0 },
          },
        }
      },
      async messages(input) {
        sessionMessagesCalls.push(input.path.id)
        return { data: options.messages ?? [] }
      },
      async promptAsync() {},
    },
    async postSessionIdPermissionsPermissionId(input) {
      replies.push(input)
    },
  }
}

function asked(id: string, command: string) {
  return {
    type: "permission.asked",
    properties: { id, sessionID: "sess1", permission: "bash", patterns: [command], always: [] },
  }
}

function replied(requestID: string) {
  return { type: "permission.replied", properties: { sessionID: "sess1", requestID, reply: "once" } }
}

describe("CalibratedAccessPlugin", () => {
  test("wires the real V1 call shape (input, options) without throwing", async () => {
    const hooks = await CalibratedAccessPlugin({ client: makeClient() }, {})
    expect(typeof hooks.event).toBe("function")
    expect(typeof hooks.dispose).toBe("function")
    await hooks.dispose()
  })

  test("exports exactly one function so getLegacyPlugins only invokes the plugin", async () => {
    const mod = await import("../src/index.ts")
    expect(Object.keys(mod)).toEqual(["CalibratedAccessPlugin"])
  })

  test("replies 'once' for a benign routine command via the SDK client", async () => {
    const client = makeClient()
    const hooks = await CalibratedAccessPlugin({ client }, {})
    await hooks.event({ event: asked("per_1", "git status") })
    expect(client.replies).toHaveLength(1)
    expect(client.replies[0]!.body.response).toBe("once")
    expect(client.replies[0]!.path.permissionID).toBe("per_1")
    await hooks.dispose()
  })

  test("reads plugin options from arg 2 (parseConfig no longer crashes)", async () => {
    const path = `/tmp/calibrated-access-plugin-${crypto.randomUUID()}.jsonl`
    const client = makeClient()
    const hooks = await CalibratedAccessPlugin({ client }, { mode: "shadow", diagnosticsPath: path })
    await hooks.event({ event: asked("per_2", "git status") })
    const lines = readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines[0]!.event).toBe("plugin_started")
    expect(lines.some((line) => line.mode === "shadow")).toBe(true)
    await hooks.dispose()
    rmSync(path, { force: true })
  })

  test("permission.replied cancels an in-flight review without replying", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = makeClient({ getGate: gate })
    const hooks = await CalibratedAccessPlugin({ client }, {})
    const inFlight = hooks.event({ event: asked("per_3", "echo hi > /tmp/x") })
    await hooks.event({ event: replied("per_3") })
    release!()
    await inFlight
    expect(client.replies).toHaveLength(0)
    await hooks.dispose()
  })

  test("loads session messages from the SDK and honors explicit prohibitions", async () => {
    const client = makeClient({
      messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "I explicitly prohibit `touch /tmp/example`." }] }],
    })
    const hooks = await CalibratedAccessPlugin({ client }, {})
    await hooks.event({ event: asked("per_4", "touch /tmp/example") })
    expect(client.sessionMessagesCalls[0]).toBe("sess1")
    expect(client.replies[0]!.body.response).toBe("reject")
    expect(client.replies[0]!.body.message).toContain("prohibit")
    await hooks.dispose()
  })

  test("dispose unsubscribes and stops dispatching events", async () => {
    const client = makeClient()
    const hooks = await CalibratedAccessPlugin({ client }, {})
    await hooks.dispose()
    await hooks.event({ event: asked("per_5", "git status") })
    expect(client.replies).toHaveLength(0)
  })
})
