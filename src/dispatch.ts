import type { CalibratedConfig, Decision, PermissionRequest, ReviewerClient, RuntimeContext, SignalScores } from "./types.ts"
import { applyDeterministicPolicy } from "./policy.ts"
import { assessSignals } from "./matrix.ts"
import { rateCommand, type FetchFn } from "./risk-rater.ts"
import { SessionApprovalCache } from "./cache.ts"
import { buildContinuationMessage } from "./resume.ts"
import { writeDiagnostic } from "./diagnostics.ts"
import { collectUserMessages, isPluginContinuation } from "./context.ts"
import { alternativesFor, alternativesSection } from "./alternatives.ts"

const ALWAYS_ENFORCED_POLICY_CODES = new Set(["catastrophic_delete", "explicit_user_prohibition"])

export async function reviewAndReply(
  context: RuntimeContext,
  client: ReviewerClient,
  config: CalibratedConfig,
  request: PermissionRequest,
  cache: SessionApprovalCache,
  startedAt: number,
  signal: AbortSignal,
  fetchFn?: FetchFn,
): Promise<void> {
  try {
    const rootSessionID = await resolveRootSessionID(context, request.sessionID)
    if (signal.aborted || !rootSessionID) return

    const rawMessages = await listMessages(context, rootSessionID)
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
    const shadowPolicy =
      policyDecision && config.mode === "shadow" && !ALWAYS_ENFORCED_POLICY_CODES.has(policyDecision.reasonCode)
        ? { kind: "allow" as const, reasonCode: `shadow_${policyDecision.reasonCode}`, reason: policyDecision.reason }
        : undefined
    const effectivePolicy = shadowPolicy ?? policyDecision
    const cacheKey = reusableCacheKey(request, rootSessionID)

    const cached = config.sessionApprovals && !effectivePolicy && cacheKey && cache.has(rootSessionID, request.action, request.always)
      ? { kind: "allow" as const, reasonCode: "session_approval_reused" as const, reason: "Reuses an approved narrow pattern from this session." }
      : undefined

    if (shadowPolicy) {
      context.showToast?.({
        title: "Shadow mode",
        message: `Shadow mode: would have blocked (${policyDecision!.reasonCode})`,
        variant: "info",
        duration: 5_000,
      })
    }

    const isRetry = detectRetryAfterDenial(rawMessages)

    let decision: Decision
    let signals: SignalScores | undefined
    if (effectivePolicy) {
      decision = effectivePolicy
    } else if (cached) {
      decision = cached
    } else {
      const model = await modelDecision(context, request, messages, config, signal, isRetry, fetchFn)
      decision = model.decision
      signals = model.signals
    }

    if (signal.aborted) return

    if (config.sessionApprovals && cacheKey && decision.kind === "allow" && !decision.reasonCode.startsWith("shadow_")) {
      cache.add(rootSessionID, request.action, request.always)
    }

    writeDiag(config, request, startedAt, decision, sourceLabel(effectivePolicy, cached, config), signals)

    if (decision.kind === "allow") {
      await client.reply({ sessionID: request.sessionID, requestID: request.id, reply: "once", protocol: request.protocol })
    } else {
      await client.reply({
        sessionID: request.sessionID,
        requestID: request.id,
        reply: "reject",
        message: `Calibrated Access blocked this action: ${decision.reason}${alternativesSection(decision.alternatives)}`,
        protocol: request.protocol,
      })
      context.showToast?.({ title: "Blocked", message: decision.reason, variant: "warning", duration: 4_000 })
      context.resumeAfterDenial?.(request.sessionID, buildContinuationMessage(decision.reason, request.resources, decision.alternatives))
    }
  } catch (error) {
    if (signal.aborted) return
    if (config.mode === "shadow") {
      writeDiag(config, request, startedAt, { kind: "allow", reasonCode: "review_failed", reason: "Permission review failed; shadow mode allowed." }, "error", undefined)
      await client.reply({ sessionID: request.sessionID, requestID: request.id, reply: "once", protocol: request.protocol }).catch(() => {})
      return
    }
    writeDiag(config, request, startedAt, { kind: "deny", reasonCode: "review_failed", reason: "Permission review failed." }, "error", undefined)
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
  context: RuntimeContext,
  request: PermissionRequest,
  userMessages: string[],
  config: CalibratedConfig,
  signal: AbortSignal,
  isRetry: boolean,
  fetchFn?: FetchFn,
): Promise<{ decision: Decision; signals: SignalScores }> {
  const raw = await rateCommand(request.resources.join(" && "), userMessages, config, isRetry, fetchFn)
  if (signal.aborted) {
    return { decision: { kind: "deny", reasonCode: "aborted", reason: "Review was cancelled." }, signals: raw }
  }

  const assessment = assessSignals(raw, config.signalThresholds)

  if (config.mode === "shadow") {
    if (assessment.kind === "block" || assessment.kind === "ask") {
      context.showToast?.({
        title: "Shadow mode",
        message: `Shadow mode: ${assessment.kind === "block" ? "would have blocked" : "would have denied pending user confirmation"} (${assessment.signal} p=${assessment.probability.toFixed(2)})`,
        variant: "info",
        duration: 5_000,
      })
    } else if (assessment.kind === "unjudged") {
      context.showToast?.({
        title: "Shadow mode",
        message: "Shadow mode: would have blocked (no confident signals)",
        variant: "info",
        duration: 5_000,
      })
    }
    return {
      decision: {
        kind: "allow",
        reasonCode: assessment.kind === "allow" ? assessment.reasonCode : `shadow_${assessment.kind}`,
        reason: assessment.reason,
      },
      signals: raw,
    }
  }

  if (assessment.kind === "unjudged") {
    return {
      decision: {
        kind: "deny",
        reasonCode: "no_confident_signals",
        reason: "The safety rater returned no confident assessment; blocked by default.",
      },
      signals: raw,
    }
  }

  if (assessment.kind === "block") {
    const reasonCode = `signal_block_${assessment.signal}`
    return {
      decision: {
        kind: "deny",
        reasonCode,
        reason: `Signal "${assessment.signal}" at ${assessment.probability.toFixed(2)} meets the block threshold; blocked.`,
        alternatives: alternativesFor(reasonCode),
      },
      signals: raw,
    }
  }

  if (assessment.kind === "ask") {
    return {
      decision: {
        kind: "deny",
        reasonCode: `signal_ask_${assessment.signal}`,
        reason: `Signal "${assessment.signal}" at ${assessment.probability.toFixed(2)} meets the ask threshold; confirm with the user before retrying.`,
      },
      signals: raw,
    }
  }

  return {
    decision: { kind: "allow", reasonCode: "signals_below_threshold", reason: assessment.reason },
    signals: raw,
  }
}

function reusableCacheKey(request: PermissionRequest, rootSessionID: string): string | undefined {
  if (request.always.length === 0) return undefined
  return `${rootSessionID}::${request.action}::${JSON.stringify([...request.always].sort())}`
}

function sourceLabel(policy: unknown, cached: unknown, config: CalibratedConfig): string {
  if (policy) return "policy"
  if (cached) return "session"
  return config.provider
}

function writeDiag(
  config: CalibratedConfig,
  request: PermissionRequest,
  startedAt: number,
  decision: Decision,
  source: string,
  signals: SignalScores | undefined,
): void {
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    requestID: request.id,
    sessionID: request.sessionID,
    action: request.action,
    elapsedMs: Math.round(performance.now() - startedAt),
    event: "decision",
    source,
    mode: config.mode,
    decision: decision.kind,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    ...(signals ? { signals: signals.signals } : {}),
  })
}

async function resolveRootSessionID(context: RuntimeContext, sessionID: string): Promise<string | null> {
  try {
    return await context.data.session.root(sessionID)
  } catch {
    return null
  }
}

async function listMessages(context: RuntimeContext, sessionID: string): Promise<unknown[]> {
  try {
    return await context.data.session.message.list(sessionID)
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
