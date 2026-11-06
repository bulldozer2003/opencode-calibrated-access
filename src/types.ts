export const SIGNAL_NAMES = [
  "destructive",
  "secret_exposure",
  "exfiltration",
  "prompt_injection",
  "scope_creep",
  "user_requested",
  "user_prohibited",
  "severity",
] as const

export type SignalName = (typeof SIGNAL_NAMES)[number]
export type RiskSignalName = Exclude<SignalName, "user_requested">

export interface SignalScores {
  signals: Record<SignalName, { probability: number; confidence: number }>
}

export type SafetyMode = "shadow" | "enforce"

export type ToolType = "bash" | "external_directory"

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  always: string[]
  protocol: "stable" | "v2"
}

export interface Decision {
  kind: "allow" | "deny"
  reasonCode: string
  reason: string
  alternatives?: string[]
}

export interface ReviewInput {
  request: {
    action: string
    resources: string[]
    sessionPatterns: string[]
  }
  context: {
    rootSessionID: string
    userMessages: string[]
  }
}

export type ProviderType = "typesafe" | "openai-compatible"

export interface CalibratedConfig {
  mode: SafetyMode
  signalThresholds: Record<RiskSignalName, { block: number; ask: number }>
  provider: ProviderType
  systemOneBaseUrl: string
  systemOneModel: string
  systemOneApiKey: string | undefined
  openaiBaseUrl: string
  openaiModel: string
  openaiApiKey: string | undefined
  sessionApprovals: boolean
  contextMessageCount: number
  diagnosticsPath: string | undefined
}

export interface ReviewerClient {
  reply(input: {
    sessionID: string
    requestID: string
    reply: "once" | "reject"
    message?: string
    protocol: "stable" | "v2"
  }): Promise<"replied" | "not_found">
}

export interface RuntimeContext {
  options: Readonly<Record<string, unknown>>
  client: unknown
  data: {
    on(type: string, handler: (event: unknown) => void): () => void
    session: {
      root(sessionID: string): string | Promise<string>
      get(sessionID: string): { id: string; parentID?: string } | undefined
      message: {
        list(sessionID: string): unknown[]
        get(sessionID: string, messageID: string): unknown
        sync(sessionID: string): Promise<void>
      }
      permission: {
        list(sessionID: string): PermissionRequest[] | undefined
        sync(sessionID: string): Promise<void>
      }
    }
  }
  showToast?(input: {
    title?: string
    message: string
    variant?: "info" | "success" | "warning" | "error"
    duration?: number
  }): void
  resumeAfterDenial?(sessionID: string, reason: string): void
}

export const CALIBRATED_PREFIX = "[Calibrated Access] The requested action was blocked:"
