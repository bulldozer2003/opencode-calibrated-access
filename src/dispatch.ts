import type { CalibratedConfig, Decision, PermissionRequest, ReviewerClient, RuntimeContext } from "./types.ts"
import { applyDeterministicPolicy } from "./policy.ts"
import { computeRisk, assessThreshold } from "./matrix.ts"
import { rateCommand } from "./risk-rater.ts"
import { SessionApprovalCache } from "./cache.ts"
import { buildContinuationMessage } from "./resume.ts"
import { writeDiagnostic, describeError } from "./diagnostics.ts"
import { collectUserMessages, isPluginContinuation } from "./context.ts"

export async function reviewAndReply(
  context: RuntimeContext,
  client: ReviewerClient,
  config: CalibratedConfig,
  request: PermissionRequest,
  cache: SessionApprovalCache,
  startedAt: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    const rootSessionID = await resolveRootSessionID(context, request.sessionID)
    if (signal.aborted || !rootSessionID) return

    const rawMessages = listMessages(context, rootSessionID)
    const messages = collectUserMessages(rawMessages, config.contextMessageCount)
    const reviewInput = {
      request: {
        action: request.action,
        resources: [...request.resources],
        sessionPatterns: [...request.always],
      },
      context: { rootSessionID, userMessages: messages },
    }

    const policyDecision = applyDeterministicPolicy(reviewInput)
    const cacheKey = reusableCacheKey(request, rootSessionID)

    const cached = !policyDecision && cacheKey && cache.has(rootSessionID, request.action, request.always)
      ? { kind: "allow" as const, reasonCode: "session_approval_reused" as const, reason: "Reuses an approved narrow pattern from this session." }
      : undefined

    const isRetry = detectRetryAfterDenial(rawMessages)
    const decision = policyDecision ?? cached ?? await modelDecision(request, messages, config, signal, isRetry)

    if (signal.aborted) return

    if (cacheKey && decision.kind === "allow") {
      cache.add(rootSessionID, request.action, request.always)
    }

    writeDiag(config, request, startedAt, decision, sourceLabel(policyDecision, cached))

    if (decision.kind === "allow") {
      await client.reply({ sessionID: request.sessionID, requestID: request.id, reply: "once", protocol: request.protocol })
    } else {
      await client.reply({
        sessionID: request.sessionID,
        requestID: request.id,
        reply: "reject",
        message: `Calibrated Access blocked this action: ${decision.reason}`,
        protocol: request.protocol,
      })
      context.showToast?.({ title: "Blocked", message: decision.reason, variant: "warning", duration: 4_000 })
      context.resumeAfterDenial?.(request.sessionID, buildContinuationMessage(decision.reason, request.resources))
    }
  } catch (error) {
    if (signal.aborted) return
    writeDiag(config, request, startedAt, { kind: "deny", reasonCode: "review_failed", reason: "Permission review failed." }, "error")
    context.showToast?.({ title: "Blocked", message: "Permission review failed; blocked by default.", variant: "error", duration: 4_000 })
    await client.reply({
      sessionID: request.sessionID,
      requestID: request.id,
      reply: "reject",
      message: "Calibrated Access failed to review this action; blocked by default.",
      protocol: request.protocol,
    }).catch(() => {})
    context.resumeAfterDenial?.(request.sessionID, "Permission review failed; continue with a lower-risk step.")
  }
}

async function modelDecision(
  request: PermissionRequest,
  userMessages: string[],
  config: CalibratedConfig,
  signal: AbortSignal,
  isRetry: boolean,
): Promise<Decision> {
  const threshold = request.action === "external_directory" ? config.riskThresholdDirectory : config.riskThresholdBash
  const raw = await rateCommand(request.resources.join(" && "), userMessages, config, isRetry)
  if (signal.aborted) return { kind: "deny", reasonCode: "aborted", reason: "Review was cancelled." }
  const risk = computeRisk(raw)
  if (assessThreshold(risk, threshold)) {
    return { kind: "allow", reasonCode: "risk_below_threshold", reason: `Risk score ${risk.risk.toFixed(3)} is below threshold ${threshold}.` }
  }
  return { kind: "deny", reasonCode: "risk_above_threshold", reason: `Risk score ${risk.risk.toFixed(3)} exceeds threshold ${threshold}.` }
}

function reusableCacheKey(request: PermissionRequest, rootSessionID: string): string | undefined {
  if (request.always.length === 0) return undefined
  return `${rootSessionID}::${request.action}::${JSON.stringify([...request.always].sort())}`
}

function sourceLabel(policy: unknown, cached: unknown): string {
  if (policy) return "policy"
  if (cached) return "session"
  return "typesafe"
}

function writeDiag(config: CalibratedConfig, request: PermissionRequest, startedAt: number, decision: Decision, source: string): void {
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    requestID: request.id,
    sessionID: request.sessionID,
    action: request.action,
    elapsedMs: Math.round(performance.now() - startedAt),
    event: "decision",
    source,
    decision: decision.kind,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
  })
}

async function resolveRootSessionID(context: RuntimeContext, sessionID: string): Promise<string | null> {
  try {
    return await context.data.session.root(sessionID)
  } catch {
    return null
  }
}

function listMessages(context: RuntimeContext, sessionID: string): unknown[] {
  try {
    return context.data.session.message.list(sessionID)
  } catch {
    return []
  }
}

function detectRetryAfterDenial(messages: unknown[]): boolean {
  return messages.some((msg) => {
    const text = typeof msg === "object" && msg !== null && "text" in (msg as Record<string, unknown>)
      ? (msg as Record<string, unknown>).text
      : undefined
    return typeof text === "string" && isPluginContinuation(text)
  })
}