import type { CalibratedConfig } from "./types.ts"

const DEFAULT_RISK_THRESHOLD_BASH = 0.4
const DEFAULT_RISK_THRESHOLD_DIRECTORY = 0.3
const DEFAULT_TYPESAFE_MODEL = "jev-latest"
const DEFAULT_CONTEXT_MESSAGE_COUNT = 3

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
    typesafeModel: nonEmptyString(options.typesafeModel, DEFAULT_TYPESAFE_MODEL, "typesafeModel"),
    typesafeApiKey: stringOption(options.typesafeApiKey, process.env.TYPESAFE_API_KEY),
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