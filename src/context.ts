import type { PermissionRequest } from "./types.ts"
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
      always: stringArray(data.always),
      protocol: "v2",
    }
  }

  if (event.type !== "permission.updated") return null
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

export function normalizeRepliedEvent(event: unknown): { sessionID: string; requestID: string } | null {
  if (!isRecord(event) || !["permission.v2.replied", "permission.replied"].includes(String(event.type))) return null
  const data = payload(event)
  const requestID = data?.requestID ?? data?.permissionID
  if (!isRecord(data) || typeof data.sessionID !== "string" || typeof requestID !== "string") return null
  return { sessionID: data.sessionID, requestID }
}

export function isPluginContinuation(text: string): boolean {
  return text.trimStart().startsWith(CALIBRATED_PREFIX)
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