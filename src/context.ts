import type { PermissionRequest, ResumeRouting } from "./types.ts"
import { CALIBRATED_PREFIX } from "./types.ts"

const MAX_MESSAGE_CHARS = 4_000

export function normalizeAskedEvent(event: unknown): PermissionRequest | null {
  if (!isRecord(event)) return null
  const data = payload(event)

  if (
    event.type === "permission.v2.asked" ||
    (event.type === "permission.asked" && data && "action" in data)
  ) {
    if (!data || typeof data.id !== "string" || typeof data.sessionID !== "string" || typeof data.action !== "string") return null
    const resources = Array.isArray(data.resources) ? data.resources.filter((r: unknown) => typeof r === "string") : []
    return {
      id: data.id,
      sessionID: data.sessionID,
      action: data.action,
      resources,
      always: stringArray(data.always ?? data.save),
      protocol: "v2",
    }
  }

  if (event.type === "permission.asked") return normalizeStableAsk(data)
  if (event.type !== "permission.updated") return null
  return normalizeStableAsk(data)
}

function normalizeStableAsk(data: Record<string, unknown> | null): PermissionRequest | null {
  if (!data || typeof data.id !== "string" || typeof data.sessionID !== "string") return null
  const action = typeof data.permission === "string" ? data.permission : data.type
  const rawResources = data.patterns ?? data.pattern
  const resources = Array.isArray(rawResources) ? rawResources : typeof rawResources === "string" ? [rawResources] : []
  if (typeof action !== "string" || resources.length === 0 || !resources.every((item: unknown) => typeof item === "string")) {
    return null
  }
  return {
    id: data.id,
    sessionID: data.sessionID,
    action,
    resources,
    always: stringArray(data.always),
    protocol: "stable",
  }
}

export function normalizeRepliedEvent(
  event: unknown,
): { sessionID: string; requestID: string; reply?: string } | null {
  if (!isRecord(event) || !["permission.v2.replied", "permission.replied"].includes(String(event.type))) return null
  const data = payload(event)
  const requestID = data?.requestID ?? data?.permissionID
  if (!isRecord(data) || typeof data.sessionID !== "string" || typeof requestID !== "string") return null
  const reply = data.reply ?? data.response
  return {
    sessionID: data.sessionID,
    requestID,
    ...(typeof reply === "string" ? { reply } : {}),
  }
}

export function isPluginContinuation(text: string): boolean {
  return text.trimStart().startsWith(CALIBRATED_PREFIX)
}

/**
 * Extract the retry justification: the newest user-visible message text that
 * follows the most recent denial continuation. The continuation message itself
 * is not a justification; the message the agent (or user) sends after it is.
 */
export function extractRetryJustification(messages: unknown[]): string | undefined {
  const textAt = (message: unknown): string | undefined =>
    typeof message === "object" && message !== null ? messageText(message as Record<string, unknown>) : undefined
  let lastContinuation = -1
  for (let i = 0; i < messages.length; i++) {
    const text = textAt(messages[i])
    if (text !== undefined && isPluginContinuation(text)) lastContinuation = i
  }
  if (lastContinuation === -1) return undefined
  for (let i = messages.length - 1; i > lastContinuation; i--) {
    const text = textAt(messages[i])
    if (text !== undefined && !isPluginContinuation(text)) return text.slice(0, MAX_MESSAGE_CHARS)
  }
  return undefined
}

export function collectUserMessages(messages: unknown[], count: number): string[] {
  return messages
    .flatMap((message) => {
      const text = userText(message)
      return text === undefined ? [] : [text.slice(0, MAX_MESSAGE_CHARS)]
    })
    .slice(-count)
}

function userText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined
  if (message.type === "user" && typeof message.text === "string") {
    return isPluginContinuation(message.text) ? undefined : message.text
  }
  if (!isRecord(message.info) || message.info.role !== "user" || !Array.isArray(message.parts)) return undefined
  const text = message.parts
    .filter(
      (part: unknown) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string" && part.synthetic !== true && part.ignored !== true,
    )
    .map((part: { text: string }) => part.text)
    .join("\n")
  return text && !isPluginContinuation(text) ? text : undefined
}

export function lastAssistantAgent(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!isRecord(message)) continue
    const text = messageText(message)
    if (text !== undefined && isPluginContinuation(text)) continue
    const agent = assistantAgent(message)
    if (agent) return agent
  }
  return undefined
}

function assistantAgent(message: Record<string, unknown>): string | undefined {
  const info = message.info
  if (isRecord(info) && info.role === "assistant" && typeof info.agent === "string") return info.agent
  if (message.role === "assistant" && typeof message.agent === "string") return message.agent
  if (message.type === "assistant" && typeof message.agent === "string") return message.agent
  return undefined
}

export function latestUserRouting(messages: unknown[]): ResumeRouting {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!isRecord(message)) continue
    const info = isRecord(message.info) ? message.info : message
    const role = typeof info.role === "string" ? info.role : typeof info.type === "string" ? info.type : undefined
    if (role !== "user") continue
    const text = messageText(message)
    if (text !== undefined && isPluginContinuation(text)) continue

    const agent = typeof info.agent === "string" ? info.agent : undefined
    const modelValue = isRecord(info.model) ? info.model : undefined
    const providerID = modelValue?.providerID
    const modelID = modelValue?.modelID ?? modelValue?.id
    const model =
      typeof providerID === "string" && typeof modelID === "string" ? { providerID, modelID } : undefined
    const variant = typeof modelValue?.variant === "string" ? modelValue.variant : undefined

    return {
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(variant ? { variant } : {}),
    }
  }
  return {}
}

function messageText(message: Record<string, unknown>): string | undefined {
  if (typeof message.text === "string") return message.text
  if (isRecord(message.info) && Array.isArray(message.parts)) {
    const text = message.parts
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
    return text.length > 0 ? text : undefined
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function payload(event: Record<string, unknown>): Record<string, unknown> | null {
  const d = event.data
  if (isRecord(d)) return d
  const p = event.properties
  return isRecord(p) ? p : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}