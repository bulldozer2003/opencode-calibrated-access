import type { CalibratedConfig, Decision, DeterministicFinding, PermissionRequest, ResumeRouting, ReviewerClient, RuntimeContext, SignalScores } from "./types.ts"
import { applyDeterministicPolicy, fastFindings, hardFindingDecision } from "./policy.ts"
import { assessSignals } from "./matrix.ts"
import { rateCommand, type FetchFn } from "./risk-rater.ts"
import { PROMPT_VERSION } from "./prompt.ts"
import { SessionApprovalCache } from "./cache.ts"
import { buildContinuationMessage, buildDenialMessage } from "./resume.ts"
import { writeDiagnostic } from "./diagnostics.ts"
import { collectUserMessages, extractRetryJustification, lastAssistantAgent, lastBlockedCommand, latestUserRouting } from "./context.ts"
import { alternativesFor } from "./alternatives.ts"

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
  let routing: ResumeRouting = {}
  try {
    const findings = fastFindings({ action: request.action, resources: [...request.resources] })
    const hard = findings.find((finding) => finding.severity === "hard")
    if (hard) {
      // The only `hard` finding is catastrophic_delete, an always-enforced code,
      // so a hard fast-path decision is never projected to shadow mode.
      const hardDecision = hardFindingDecision(hard)
      writeDiag(config, request, startedAt, hardDecision, "policy", undefined, findings)
      if (hardDecision.kind === "allow") {
        await client.reply({ sessionID: request.sessionID, requestID: request.id, reply: "once", protocol: request.protocol })
      } else {
        await client.reply({
          sessionID: request.sessionID,
          requestID: request.id,
          reply: "reject",
          message: buildDenialMessage(hardDecision.reason, hardDecision.alternatives),
          protocol: request.protocol,
        })
        context.showToast?.({ title: "Blocked", message: hardDecision.reason, variant: "warning", duration: 4_000 })
        routing = resolveRouting(await listMessages(context, request.sessionID))
        context.resumeAfterDenial?.(request.sessionID, buildContinuationMessage(hardDecision.reason, request.resources, hardDecision.alternatives), routing)
      }
      return
    }

    const rootSessionID = await resolveRootSessionID(context, request.sessionID)
    if (signal.aborted || !rootSessionID) return

    const rawMessages = await listMessages(context, rootSessionID)
    routing = resolveRouting(rawMessages)
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

    const isRetry = detectRetryAfterDenial(rawMessages, request.resources.join(" && "))
    const justification = isRetry ? extractRetryJustification(rawMessages) : undefined
    const appealExhausted = isRetry && cache.hasAppeal(rootSessionID, request.action, request.always)
    const cautions = findings.filter((finding) => finding.severity === "caution")

    let decision: Decision
    let signals: SignalScores | undefined
    let justified = false
    if (appealExhausted) {
      const reason = "The one appeal for this request was already used; a second retry is blocked outright."
      if (config.mode === "shadow") {
        context.showToast?.({ title: "Shadow mode", message: "Shadow mode: would have blocked (appeal_exhausted)", variant: "info", duration: 5_000 })
        decision = { kind: "allow", reasonCode: "shadow_appeal_exhausted", reason }
      } else {
        decision = { kind: "deny", reasonCode: "appeal_exhausted", reason }
      }
    } else if (effectivePolicy) {
      decision = effectivePolicy
    } else if (cached) {
      decision = cached
    } else {
      const model = await modelDecision(context, request, messages, config, isRetry, cautions, fetchFn, justification)
      decision = model.decision
      signals = model.signals
      justified = justification !== undefined
    }

    if (isRetry && justification && !appealExhausted) {
      cache.markAppeal(rootSessionID, request.action, request.always)
    }

    // A model review can finish after the request is already resolved: `opencode
    // run`'s headless client auto-rejects on `permission.asked` without waiting
    // for the plugin. Record the completed review for calibration, but never
    // reply or cache an approval for a permission that is already settled.
    writeDiag(config, request, startedAt, decision, appealExhausted ? "appeal" : sourceLabel(effectivePolicy, cached, config), signals, cautions, justified)
    if (signal.aborted) return

    if (config.sessionApprovals && cacheKey && decision.kind === "allow" && !decision.reasonCode.startsWith("shadow_")) {
      cache.add(rootSessionID, request.action, request.always)
    }

    if (decision.kind === "allow") {
      await client.reply({ sessionID: request.sessionID, requestID: request.id, reply: "once", protocol: request.protocol })
    } else {
      await client.reply({
        sessionID: request.sessionID,
        requestID: request.id,
        reply: "reject",
        message: buildDenialMessage(decision.reason, decision.alternatives),
        protocol: request.protocol,
      })
      context.showToast?.({ title: "Blocked", message: decision.reason, variant: "warning", duration: 4_000 })
      context.resumeAfterDenial?.(request.sessionID, buildContinuationMessage(decision.reason, request.resources, decision.alternatives), routing)
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
    context.resumeAfterDenial?.(request.sessionID, "Permission review failed; continue with a lower-risk step.", routing)
  }
}

async function modelDecision(
  context: RuntimeContext,
  request: PermissionRequest,
  userMessages: string[],
  config: CalibratedConfig,
  isRetry: boolean,
  findings: DeterministicFinding[],
  fetchFn?: FetchFn,
  justification?: string,
): Promise<{ decision: Decision; signals: SignalScores }> {
  const raw = await rateCommand(request.resources.join(" && "), userMessages, config, isRetry, fetchFn, findings, justification)
  const assessment = assessSignals(raw, config.signalThresholds, findings, { justification: justification !== undefined })

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
    const finding = findings.find((entry) => entry.code === assessment.signal)
    const findingAlternatives = finding ? alternativesFor(finding.code) : undefined
    return {
      decision: {
        kind: "deny",
        reasonCode,
        reason: finding
          ? `${finding.message} The judge's signal "${assessment.signal}" at ${assessment.probability.toFixed(2)} meets the block threshold; the deterministic finding and the judge agree, so the action is blocked.`
          : `Signal "${assessment.signal}" at ${assessment.probability.toFixed(2)} meets the block threshold; blocked.`,
        alternatives: findingAlternatives && findingAlternatives.length > 0 ? findingAlternatives : alternativesFor(reasonCode),
      },
      signals: raw,
    }
  }

  if (assessment.kind === "ask") {
    const findingAlternatives = findingAlternativesFor(assessment.signal, findings)
    return {
      decision: {
        kind: "deny",
        reasonCode: `signal_ask_${assessment.signal}`,
        reason: assessment.finding || assessment.justification
          ? assessment.reason
          : `Signal "${assessment.signal}" at ${assessment.probability.toFixed(2)} meets the ask threshold; confirm with the user before retrying.`,
        ...(findingAlternatives ? { alternatives: findingAlternatives } : {}),
      },
      signals: raw,
    }
  }

  return {
    decision: { kind: "allow", reasonCode: "signals_below_threshold", reason: assessment.reason },
    signals: raw,
  }
}

function findingAlternativesFor(signal: string, findings: DeterministicFinding[]): string[] | undefined {
  const finding = findings.find((entry) => entry.code === signal)
  if (!finding) return undefined
  const alternatives = alternativesFor(finding.code)
  return alternatives.length > 0 ? alternatives : undefined
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
  findings: DeterministicFinding[] = [],
  justified = false,
): void {
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    requestID: request.id,
    sessionID: request.sessionID,
    action: request.action,
    command: request.resources.join(" && "),
    elapsedMs: Math.round(performance.now() - startedAt),
    event: "decision",
    source,
    mode: config.mode,
    promptVersion: PROMPT_VERSION,
    decision: decision.kind,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    ...(justified ? { justified: true } : {}),
    ...(findings.length > 0 ? { findings: findings.map((finding) => ({ code: finding.code, severity: finding.severity, message: finding.message })) } : {}),
    ...(signals ? { signals: signals.signals } : {}),
    ...(signals?.usage !== undefined ? { usage: signals.usage } : {}),
    ...(signals?.cost !== undefined ? { cost: signals.cost } : {}),
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

function resolveRouting(messages: unknown[]): ResumeRouting {
  const userRouting = latestUserRouting(messages)
  if (userRouting.agent || userRouting.model || userRouting.variant) return userRouting
  const agent = lastAssistantAgent(messages)
  return agent ? { agent } : {}
}

function detectRetryAfterDenial(messages: unknown[], command: string): boolean {
  const blocked = lastBlockedCommand(messages)
  return blocked !== undefined && blocked === command
}
