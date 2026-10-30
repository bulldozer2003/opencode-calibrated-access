import type { CalibratedConfig, ProviderType } from "./types.ts"

const DEFAULT_RISK_THRESHOLD_BASH = 0.4
const DEFAULT_RISK_THRESHOLD_DIRECTORY = 0.3
const DEFAULT_SYSTEM_ONE_BASE_URL = "https://api.typesafe.ai/v1"
const DEFAULT_SYSTEM_ONE_MODEL = "jev-latest"
const DEFAULT_CONTEXT_MESSAGE_COUNT = 3
const DEFAULT_PROVIDER: ProviderType = "typesafe"
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"

export function parseConfig(options: Readonly<Record<string, unknown>>): CalibratedConfig {
  return {
    riskThresholdBash: boundedFloat(options.riskThresholdBash, DEFAULT_RISK_THRESHOLD_BASH, 0, 1, "riskThresholdBash"),
    riskThresholdDirectory: boundedFloat(
      options.riskThresholdDirectory,
      DEFAULT_RISK_THRESHOLD_DIRECTORY,
      0,
      1,
      "riskThresholdDirectory",
    ),
    provider: parseProvider(options.provider),
    systemOneBaseUrl: nonEmptyString(
      options.systemOneBaseUrl,
      DEFAULT_SYSTEM_ONE_BASE_URL,
      "systemOneBaseUrl",
    ),
    systemOneModel: nonEmptyString(
      options.systemOneModel ?? options.typesafeModel,
      DEFAULT_SYSTEM_ONE_MODEL,
      "systemOneModel",
    ),
    systemOneApiKey: stringOption(
      options.systemOneApiKey ?? options.typesafeApiKey,
      process.env.TYPESAFE_API_KEY,
    ),
    openaiBaseUrl: nonEmptyString(options.openaiBaseUrl, DEFAULT_OPENAI_BASE_URL, "openaiBaseUrl"),
    openaiModel: nonEmptyString(options.openaiModel, "gpt-4o-mini", "openaiModel"),
    openaiApiKey: stringOption(options.openaiApiKey, process.env.OPENAI_API_KEY),
    sessionApprovals: options.sessionApprovals !== false,
    contextMessageCount: boundedInteger(
      options.contextMessageCount,
      DEFAULT_CONTEXT_MESSAGE_COUNT,
      1,
      10,
      "contextMessageCount",
    ),
    diagnosticsPath: stringOption(options.diagnosticsPath, undefined),
  }
}

function parseProvider(value: unknown): ProviderType {
  if (value === undefined) return DEFAULT_PROVIDER
  if (value === "typesafe" || value === "openai-compatible") return value
  throw new Error(`Calibrated Access provider must be "typesafe" or "openai-compatible"`)
}

function boundedFloat(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || isNaN(value) || value < min || value > max) {
    throw new Error(`Calibrated Access ${name} must be a number from ${min} to ${max}`)
  }
  return value
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Calibrated Access ${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value as number
}

function nonEmptyString(value: unknown, fallback: string, name: string): string {
  if (value === undefined) return fallback
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Calibrated Access ${name} must be a non-empty string`)
  }
  return value.trim()
}

function stringOption(value: unknown, envFallback: string | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (envFallback) return envFallback
  return undefined
}