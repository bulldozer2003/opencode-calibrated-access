import type { RuntimeContext } from "./types.ts"
import { installReviewer } from "./reviewer.ts"

type EventHandler = (event: unknown) => void

interface SessionRecord {
  id?: string
  parentID?: string
}

interface SessionClient {
  session?: {
    get?(input: { path: { id: string } }): Promise<unknown>
    messages?(input: { path: { id: string } }): Promise<unknown>
  }
}

export interface CalibratedAccessPluginInput {
  client?: unknown
}

export interface CalibratedAccessHooks {
  event(input: { event: unknown }): Promise<void>
  dispose(): Promise<void>
}

export const CalibratedAccessPlugin = async (
  input: CalibratedAccessPluginInput = {},
  options: Record<string, unknown> = {},
): Promise<CalibratedAccessHooks> => {
  const client = (input.client ?? {}) as SessionClient
  const handlers = new Map<string, EventHandler[]>()

  const context: RuntimeContext = {
    options,
    client,
    data: {
      on(type, handler) {
        const list = handlers.get(type) ?? []
        list.push(handler)
        handlers.set(type, list)
        return () => {
          handlers.set(type, (handlers.get(type) ?? []).filter((item) => item !== handler))
        }
      },
      session: {
        root: (sessionID) => resolveRoot(client, sessionID),
        get: () => undefined,
        message: {
          list: (sessionID) => fetchMessages(client, sessionID),
          get: () => undefined,
          sync: async () => {},
        },
        permission: {
          list: () => undefined,
          sync: async () => {},
        },
      },
    },
  }

  const disposeReviewer = installReviewer(context)

  return {
    async event({ event }) {
      const type = eventType(event)
      if (!type) return
      for (const handler of handlers.get(type) ?? []) {
        await handler(event)
      }
    },
    async dispose() {
      disposeReviewer()
      handlers.clear()
    },
  }
}

async function resolveRoot(client: SessionClient, sessionID: string): Promise<string> {
  let id = sessionID
  for (let depth = 0; depth < 50; depth++) {
    const parent = (await getSession(client, id))?.parentID
    if (typeof parent !== "string" || parent.length === 0) return id
    id = parent
  }
  return id
}

async function getSession(client: SessionClient, sessionID: string): Promise<SessionRecord | undefined> {
  try {
    return unwrapData<SessionRecord>(await client.session?.get?.({ path: { id: sessionID } }))
  } catch {
    return undefined
  }
}

async function fetchMessages(client: SessionClient, sessionID: string): Promise<unknown[]> {
  try {
    const data = unwrapData<unknown>(await client.session?.messages?.({ path: { id: sessionID } }))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function unwrapData<T>(result: unknown): T | undefined {
  if (result && typeof result === "object" && "data" in result) {
    return (result as { data?: T }).data
  }
  return result as T | undefined
}

function eventType(event: unknown): string | undefined {
  if (event && typeof event === "object" && "type" in event && typeof (event as { type?: unknown }).type === "string") {
    return (event as { type: string }).type
  }
  return undefined
}
