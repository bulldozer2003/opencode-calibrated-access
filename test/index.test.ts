import { describe, expect, test } from "bun:test"
import { installReviewer } from "../src/index.ts"
import type { ReviewerClient, RuntimeContext } from "../src/types.ts"

type Handler = (event: unknown) => void
type ReplyInput = Parameters<ReviewerClient["reply"]>[0]

interface MockRuntime {
  context: RuntimeContext
  emit(type: string, event: unknown): Promise<void>
  registered(): string[]
  unregistered(): string[]
}

function makeRuntime(client: unknown = {}): MockRuntime {
  const handlers = new Map<string, Handler[]>()
  const registered: string[] = []
  const unregistered: string[] = []

  const context: RuntimeContext = {
    options: {},
    client,
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
        message: { list: () => [], get: () => undefined, sync: async () => {} },
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
})
