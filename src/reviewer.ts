import type { RuntimeContext, CalibratedConfig, ResumeRouting, ReviewerClient, PermissionRequest } from "./types.ts"
import { parseConfig } from "./config.ts"
import { normalizeAskedEvent, normalizeRepliedEvent, isPluginContinuation } from "./context.ts"
import { SessionApprovalCache } from "./cache.ts"
import { reviewAndReply } from "./dispatch.ts"
import { writeDiagnostic, describeError } from "./diagnostics.ts"

interface PluginOverrides {
  client?: ReviewerClient
  cache?: SessionApprovalCache
  sleep?: () => Promise<void>
  idleSleep?: () => Promise<void>
  idleIntervalMs?: number
  idleMaxWaitMs?: number
  onDecision?(request: PermissionRequest, decision: { kind: string; reasonCode: string }): void
  onFailure?(request: PermissionRequest, error: unknown): void
}

interface IdleWaitConfig {
  sleep: () => Promise<void>
  intervalMs: number
  maxWaitMs: number
}

const defaultSleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 750))
const DEFAULT_IDLE_INTERVAL_MS = 250
const DEFAULT_IDLE_MAX_WAIT_MS = 10000

export function installReviewer(context: RuntimeContext, overrides: PluginOverrides = {}): () => void {
  const config = parseConfig(context.options)
  const inFlight = new Map<string, AbortController>()
  const pendingRequests = new Map<string, PermissionRequest>()
  const pluginReplies = new Set<string>()
  const cache = overrides.cache ?? new SessionApprovalCache()
  const sleep = overrides.sleep ?? defaultSleep
  const idle: IdleWaitConfig = {
    sleep: overrides.idleSleep ?? (() => new Promise((resolve) => setTimeout(resolve, overrides.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS))),
    intervalMs: overrides.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS,
    maxWaitMs: overrides.idleMaxWaitMs ?? DEFAULT_IDLE_MAX_WAIT_MS,
  }
  const runtime: RuntimeContext = {
    ...context,
    resumeAfterDenial: context.resumeAfterDenial ?? ((sessionID, message, routing) => {
      void resumeSession(context.client, sessionID, message, routing, context.directory, config.diagnosticsPath, sleep, idle)
    }),
  }

  writeDiag(config, { event: "plugin_started", directory: context.directory ?? null })

  const baseClient = overrides.client ?? buildClient(context)
  const client: ReviewerClient = {
    async reply(input) {
      pluginReplies.add(input.requestID)
      return baseClient.reply(input)
    },
  }

  const handleReplied = async (event: unknown) => {
    const reply = normalizeRepliedEvent(event)
    if (!reply) return
    cancelInFlight(inFlight, reply.requestID)
    const request = pendingRequests.get(reply.requestID)
    pendingRequests.delete(reply.requestID)
    if (pluginReplies.delete(reply.requestID)) return
    if (!request || !config.sessionApprovals) return
    if (reply.reply !== "always" || request.always.length === 0) return
    cache.add(reply.sessionID, request.action, request.always)
  }

  const offReplied = context.data.on("permission.v2.replied", handleReplied)
  const offStableReplied = context.data.on("permission.replied", handleReplied)

  const handler = async (event: unknown) => {
    const asked = normalizeAskedEvent(event)
    if (!asked || inFlight.has(asked.id)) return

    const controller = new AbortController()
    const startedAt = performance.now()
    inFlight.set(asked.id, controller)
    pendingRequests.set(asked.id, asked)

    try {
      writeDiag(config, { event: "request_received", requestID: asked.id, sessionID: asked.sessionID, action: asked.action })
      await reviewAndReply(runtime, client, config, asked, cache, startedAt, controller.signal)
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
    pendingRequests.clear()
    pluginReplies.clear()
    cache.clear()
  }
}

type ResumeOutcome = { ok: true } | { ok: false; error: unknown }

function isErrorResult(result: unknown): boolean {
  return typeof result === "object" && result !== null && Boolean((result as { error?: unknown }).error)
}

async function attemptResume(
  prompt: (...args: any[]) => unknown,
  session: unknown,
  sessionID: string,
  message: string,
  routing: ResumeRouting | undefined,
  directory: string | undefined,
): Promise<ResumeOutcome> {
  try {
    const body: Record<string, unknown> = { parts: [{ type: "text", text: message }] }
    if (routing?.agent) body.agent = routing.agent
    if (routing?.model) body.model = routing.model
    if (routing?.variant) body.variant = routing.variant
    const input: Record<string, unknown> = { path: { id: sessionID }, body }
    if (directory) input.query = { directory }
    const result = (await prompt.call(session, input)) as { data?: unknown; error?: unknown } | undefined
    return isErrorResult(result) ? { ok: false, error: result?.error } : { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

function sanitizeResumeError(error: unknown): string {
  let text: string
  if (error instanceof Error) {
    text = `${error.name}: ${error.message}`
  } else {
    try {
      text = JSON.stringify(error) ?? String(error)
    } catch {
      text = String(error)
    }
  }
  return text.length > 500 ? text.slice(0, 500) + "..." : text
}

type ProbeResult = { result: "idle" | "busy" | "absent" | "error"; error?: unknown }

async function probeSessionStatus(
  session: Record<string, any>,
  sessionID: string,
  directory: string | undefined,
): Promise<ProbeResult> {
  const status = session.status
  if (typeof status !== "function") return { result: "idle" }
  try {
    const result = (await status.call(session, directory ? { query: { directory } } : {})) as
      | { data?: unknown; error?: unknown }
      | undefined
    const payload = result && typeof result === "object" && "error" in result ? result.data : result
    if (!payload || typeof payload !== "object") return { result: "absent" }
    const entry = (payload as Record<string, unknown>)[sessionID]
    if (!entry || typeof entry !== "object") return { result: "absent" }
    return { result: (entry as { type?: unknown }).type === "idle" ? "idle" : "busy" }
  } catch (error) {
    return { result: "error", error }
  }
}

type IdleResult = { idle: true; waitMs: number } | { idle: false; waitMs: number }

async function waitForIdle(
  session: Record<string, any>,
  sessionID: string,
  config: IdleWaitConfig,
  directory: string | undefined,
  diagnosticsPath?: string,
): Promise<IdleResult> {
  if (typeof session.status !== "function") return { idle: true, waitMs: 0 }
  const maxAttempts = Math.max(1, Math.ceil(config.maxWaitMs / config.intervalMs))
  let waitMs = 0
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const probe = await probeSessionStatus(session, sessionID, directory)
    writeDiagnostic(diagnosticsPath, {
      event: "resume_probe",
      sessionID,
      attempt: attempt + 1,
      result: probe.result,
      scoped: Boolean(directory),
      ...(probe.result === "error" ? { error: sanitizeResumeError(probe.error) } : {}),
    })
    if (probe.result === "idle" || probe.result === "absent") return { idle: true, waitMs }
    await config.sleep()
    waitMs += config.intervalMs
  }
  return { idle: false, waitMs }
}

const VERIFY_MAX_WAIT_MS = 2000

async function fetchSessionMessages(
  session: Record<string, any>,
  sessionID: string,
  directory: string | undefined,
): Promise<unknown[] | null> {
  if (typeof session.messages !== "function") return null
  try {
    const input: Record<string, unknown> = { path: { id: sessionID } }
    if (directory) input.query = { directory }
    const result = (await session.messages(input)) as unknown
    const payload =
      result && typeof result === "object" && "data" in (result as Record<string, unknown>)
        ? (result as { data?: unknown }).data
        : result
    return Array.isArray(payload) ? payload : null
  } catch {
    return null
  }
}

function messageHasContinuation(message: unknown): boolean {
  if (!message || typeof message !== "object") return false
  const record = message as Record<string, any>
  const text =
    typeof record.text === "string"
      ? record.text
      : Array.isArray(record.parts)
        ? record.parts
            .filter((part: any) => part && typeof part.text === "string")
            .map((part: any) => part.text as string)
            .join("\n")
        : undefined
  return typeof text === "string" && isPluginContinuation(text)
}

async function verifyExecution(
  session: Record<string, any>,
  sessionID: string,
  config: IdleWaitConfig,
  directory: string | undefined,
): Promise<boolean | null> {
  if (typeof session.messages !== "function") return null
  const maxAttempts = Math.max(1, Math.ceil(VERIFY_MAX_WAIT_MS / config.intervalMs))
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const messages = await fetchSessionMessages(session, sessionID, directory)
    if (messages === null) return null
    if (messages.some(messageHasContinuation)) return true
    await config.sleep()
  }
  return false
}

function routingDiagnostic(routing: ResumeRouting | undefined): { routing?: Record<string, unknown> } {
  if (!routing) return {}
  const entry: Record<string, unknown> = {}
  if (routing.agent) entry.agent = routing.agent
  if (routing.model) entry.model = routing.model
  if (routing.variant) entry.variant = routing.variant
  return Object.keys(entry).length > 0 ? { routing: entry } : {}
}

async function resumeSession(
  client: unknown,
  sessionID: string,
  message: string,
  routing: ResumeRouting | undefined,
  directory: string | undefined,
  diagnosticsPath?: string,
  sleep: () => Promise<void> = defaultSleep,
  idle: IdleWaitConfig = {
    sleep: () => new Promise((resolve) => setTimeout(resolve, DEFAULT_IDLE_INTERVAL_MS)),
    intervalMs: DEFAULT_IDLE_INTERVAL_MS,
    maxWaitMs: DEFAULT_IDLE_MAX_WAIT_MS,
  },
): Promise<void> {
  const session = (client as Record<string, any> | null | undefined)?.session
  if (!session) return
  const prompt = typeof session.promptAsync === "function" ? session.promptAsync : session.prompt
  if (typeof prompt !== "function") return

  let totalWaitMs = 0
  let failOpen = false

  const first = await waitForIdle(session, sessionID, idle, directory, diagnosticsPath)
  totalWaitMs += first.waitMs
  if (!first.idle) failOpen = true

  let outcome = await attemptResume(prompt, session, sessionID, message, routing, directory)
  let attempt = 1
  if (!outcome.ok) {
    await sleep()
    const second = await waitForIdle(session, sessionID, idle, directory, diagnosticsPath)
    totalWaitMs += second.waitMs
    if (!second.idle) failOpen = true
    outcome = await attemptResume(prompt, session, sessionID, message, routing, directory)
    attempt = 2
  }

  if (outcome.ok) {
    const started = await verifyExecution(session, sessionID, idle, directory)
    writeDiagnostic(diagnosticsPath, {
      event: "resume",
      ok: true,
      sessionID,
      attempt,
      waitMs: totalWaitMs,
      failOpen,
      ...(started === null ? {} : { started }),
      ...(started === false ? { note: "prompt accepted but no turn started" } : {}),
      ...routingDiagnostic(routing),
    })
  } else {
    writeDiagnostic(diagnosticsPath, {
      event: "resume",
      ok: false,
      sessionID,
      attempt,
      failOpen,
      error: sanitizeResumeError(outcome.error),
      ...routingDiagnostic(routing),
    })
  }
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
