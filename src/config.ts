import type { CalibratedConfig, ProviderType, RiskSignalName, SafetyMode } from "./types.ts"
import { SIGNAL_NAMES } from "./types.ts"
import { DEFAULT_SIGNAL_THRESHOLDS } from "./matrix.ts"

const DEFAULT_SYSTEM_ONE_BASE_URL = "https://api.typesafe.ai/v1"
const DEFAULT_SYSTEM_ONE_MODEL = "jev-latest"
const DEFAULT_CONTEXT_MESSAGE_COUNT = 3
const DEFAULT_PROVIDER: ProviderType = "typesafe"
const DEFAULT_MODE: SafetyMode = "enforce"
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini"

export function parseConfig(options: Readonly<Record<string, unknown>>): CalibratedConfig {
  return {
    mode: parseMode(options.mode),
    signalThresholds: parseSignalThresholds(options.signalThresholds),
    provider: parseProvider(options.provider),
    systemOneBaseUrl: nonEmptyString(
      options.systemOneBaseUrl,
      DEFAULT_SYSTEM_ONE_BASE_URL,
      "systemOneBaseUrl",
    ),
    systemOneModel: nonEmptyString(
      resolveAliasedValue(options.systemOneModel, options.typesafeModel),
      DEFAULT_SYSTEM_ONE_MODEL,
      "systemOneModel",
    ),
    systemOneApiKey: stringOption(
      firstNonBlank(options.systemOneApiKey, options.typesafeApiKey),
      process.env.TYPESAFE_API_KEY,
    ),
    openaiBaseUrl: nonEmptyString(options.openaiBaseUrl, DEFAULT_OPENAI_BASE_URL, "openaiBaseUrl"),
    openaiModel: nonEmptyString(options.openaiModel, DEFAULT_OPENAI_MODEL, "openaiModel"),
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

function parseMode(value: unknown): SafetyMode {
  if (value === undefined) return DEFAULT_MODE
  if (value === "shadow" || value === "enforce") return value
  throw new Error(`Calibrated Access mode must be "shadow" or "enforce"`)
}

function parseSignalThresholds(value: unknown): Record<RiskSignalName, { block: number; ask: number }> {
  if (value === undefined) return cloneDefaultThresholds()
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Calibrated Access signalThresholds must be an object`)
  }
  const result = cloneDefaultThresholds()
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isRiskSignalName(key)) {
      throw new Error(`Calibrated Access signalThresholds.${key} is not a known signal`)
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Calibrated Access signalThresholds.${key} must be an object`)
    }
    const record = entry as Record<string, unknown>
    const block = record.block === undefined ? result[key].block : thresholdNumber(record.block, key, "block")
    const ask = record.ask === undefined ? result[key].ask : thresholdNumber(record.ask, key, "ask")
    if (ask > block) {
      throw new Error(`Calibrated Access signalThresholds.${key} ask must be <= block`)
    }
    result[key] = { block, ask }
  }
  return result
}

function isRiskSignalName(key: string): key is RiskSignalName {
  return key !== "user_requested" && (SIGNAL_NAMES as readonly string[]).includes(key)
}

function thresholdNumber(value: unknown, signal: string, field: string): number {
  if (typeof value !== "number" || isNaN(value) || value < 0 || value > 1) {
    throw new Error(`Calibrated Access signalThresholds.${signal} ${field} must be a number from 0 to 1`)
  }
  return value
}

function cloneDefaultThresholds(): Record<RiskSignalName, { block: number; ask: number }> {
  return Object.fromEntries(
    (Object.keys(DEFAULT_SIGNAL_THRESHOLDS) as RiskSignalName[]).map((key) => [key, { ...DEFAULT_SIGNAL_THRESHOLDS[key] }]),
  ) as Record<RiskSignalName, { block: number; ask: number }>
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

function firstNonBlank(...values: unknown[]): unknown {
  for (const value of values) {
    if (typeof value === "string") {
      if (value.trim().length > 0) return value.trim()
      continue
    }
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function resolveAliasedValue(primary: unknown, alias: unknown): unknown {
  const aliasValue = firstNonBlank(alias)
  if (typeof primary === "string" && !primary.trim() && aliasValue !== undefined) {
    return aliasValue
  }
  return primary ?? aliasValue
}

function stringOption(value: unknown, envFallback: string | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (envFallback) return envFallback
  return undefined
}
