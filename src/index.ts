import type { RuntimeContext, CalibratedConfig, ReviewerClient, PermissionRequest } from "./types.ts"
import { parseConfig } from "./config.ts"
import { normalizeAskedEvent, normalizeRepliedEvent } from "./context.ts"
import { SessionApprovalCache } from "./cache.ts"
import { reviewAndReply } from "./dispatch.ts"
import { writeDiagnostic, describeError } from "./diagnostics.ts"

interface PluginOverrides {
  client?: ReviewerClient
  onDecision?(request: PermissionRequest, decision: { kind: string; reasonCode: string }): void
  onFailure?(request: PermissionRequest, error: unknown): void
}

export function installReviewer(context: RuntimeContext, overrides: PluginOverrides = {}): () => void {
  const config = parseConfig(context.options)
  const inFlight = new Map<string, AbortController>()
  const cache = new SessionApprovalCache()
  const runtime: RuntimeContext = {
    ...context,
    resumeAfterDenial: context.resumeAfterDenial ?? ((sessionID, message) => {
      void resumeSession(context.client, sessionID, message)
    }),
  }

  writeDiag(config, { event: "plugin_started" })

  const offReplied = context.data.on("permission.v2.replied", (event) => {
    const reply = normalizeRepliedEvent(event)
    if (reply) cancelInFlight(inFlight, reply.requestID)
  })

  const offStableReplied = context.data.on("permission.replied", (event) => {
    const reply = normalizeRepliedEvent(event)
    if (reply) cancelInFlight(inFlight, reply.requestID)
  })

  const handler = async (event: unknown) => {
    const asked = normalizeAskedEvent(event)
    if (!asked || inFlight.has(asked.id)) return

    const controller = new AbortController()
    const startedAt = performance.now()
    inFlight.set(asked.id, controller)

    try {
      writeDiag(config, { event: "request_received", requestID: asked.id, sessionID: asked.sessionID, action: asked.action })
      await reviewAndReply(runtime, overrides.client ?? buildClient(context), config, asked, cache, startedAt, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return
      overrides.onFailure?.(asked, error)
      writeDiag(config, { event: "failure", requestID: asked.id, error: describeError(error).message })
    } finally {
      if (inFlight.get(asked.id) === controller) inFlight.delete(asked.id)
    }
  }

  const offV2Asked = context.data.on("permission.v2.asked", handler)
  const offStableAsked = context.data.on("permission.asked", handler)
  const offUpdated = context.data.on("permission.updated", handler)

  return () => {
    offV2Asked()
    offStableAsked()
    offUpdated()
    offReplied()
    offStableReplied()
    for (const c of inFlight.values()) c.abort("plugin disposed")
    inFlight.clear()
    cache.clear()
  }
}

async function resumeSession(client: unknown, sessionID: string, message: string): Promise<void> {
  const session = (client as Record<string, any> | null | undefined)?.session
  if (!session) return
  const prompt = typeof session.promptAsync === "function" ? session.promptAsync : session.prompt
  if (typeof prompt !== "function") return
  try {
    await prompt.call(session, { path: { id: sessionID }, body: { parts: [{ type: "text", text: message }] } })
  } catch {}
}

function buildClient(context: RuntimeContext): ReviewerClient {
  return {
    async reply(input) {
      const client = context.client as Record<string, any>
      try {
        if (typeof client?.permission?.reply === "function") {
          await client.permission.reply({
            sessionID: input.sessionID,
            requestID: input.requestID,
            reply: input.reply,
            ...(input.message ? { message: input.message } : {}),
          })
          return "replied"
        }
        if (typeof client?.postSessionIdPermissionsPermissionId === "function") {
          await client.postSessionIdPermissionsPermissionId({
            path: { id: input.sessionID, permissionID: input.requestID },
            body: { response: input.reply, ...(input.message ? { message: input.message } : {}) },
          })
          return "replied"
        }
        return "not_found"
      } catch {
        return "not_found"
      }
    },
  }
}

function cancelInFlight(inFlight: Map<string, AbortController>, requestID: string): void {
  const controller = inFlight.get(requestID)
  if (controller && !controller.signal.aborted) {
    controller.abort("permission resolved")
  }
}

function writeDiag(config: CalibratedConfig, data: Record<string, unknown>): void {
  writeDiagnostic(config.diagnosticsPath, data)
}