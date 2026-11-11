import { CALIBRATED_PREFIX } from "./types.ts"
import { alternativesSection } from "./alternatives.ts"

const TWO_PATHS = `You have two paths:
- Modify: Do not retry the exact blocked action; use a safer alternative (see below) and ask the user only if no useful safe path remains.
- Justify: If the user explicitly asked for this exact action, retry it once with a clear justification tied to the user's request. The judge weighs the justification; a sound justification downgrades the block to a confirmation ask, never a silent allow. A second retry after a justification is blocked outright.`

export function buildContinuationMessage(reason: string, resources: string[], alternatives?: string[]): string {
  const command = resources.join(" && ")
  return `${CALIBRATED_PREFIX} ${reason} (blocked: ${command}). ${TWO_PATHS}${alternativesSection(alternatives)}`
}

export function buildDenialMessage(reason: string, alternatives?: string[]): string {
  return `Calibrated Access blocked this action: ${reason}. ${TWO_PATHS}${alternativesSection(alternatives)}`
}
