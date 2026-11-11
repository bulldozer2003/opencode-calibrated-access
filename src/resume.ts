import { CALIBRATED_PREFIX } from "./types.ts"
import { alternativesSection } from "./alternatives.ts"

const TWO_PATHS_HEADER = "You have two paths:"
const TWO_PATHS = `${TWO_PATHS_HEADER}
- Modify: Do not retry the exact blocked action; use a safer alternative (see below) and ask the user only if no useful safe path remains.
- Justify: If the user explicitly asked for this exact action, retry it once with a clear justification tied to the user's request. The judge weighs the justification; a sound justification downgrades the block to a confirmation ask, never a silent allow. A second retry after a justification is blocked outright.`

const BLOCKED_COMMAND_PREFIX = "(blocked: "
const BLOCKED_COMMAND_SUFFIX = `). ${TWO_PATHS_HEADER}`

export function buildContinuationMessage(reason: string, resources: string[], alternatives?: string[]): string {
  const command = resources.join(" && ")
  return `${CALIBRATED_PREFIX} ${reason} ${BLOCKED_COMMAND_PREFIX}${command}${BLOCKED_COMMAND_SUFFIX}${TWO_PATHS.slice(TWO_PATHS_HEADER.length)}${alternativesSection(alternatives)}`
}

/**
 * Recover the blocked command from a continuation message. The command is the
 * identity a justified retry must match: a retry of a DIFFERENT command is a
 * fresh request (the modify path), never a justification. Shares its delimiters
 * with `buildContinuationMessage` so the two cannot drift.
 */
export function extractBlockedCommand(text: string): string | undefined {
  const start = text.indexOf(BLOCKED_COMMAND_PREFIX)
  if (start === -1) return undefined
  const rest = text.slice(start + BLOCKED_COMMAND_PREFIX.length)
  const end = rest.indexOf(BLOCKED_COMMAND_SUFFIX)
  if (end === -1) return undefined
  return rest.slice(0, end)
}

export function buildDenialMessage(reason: string, alternatives?: string[]): string {
  return `Calibrated Access blocked this action: ${reason}. ${TWO_PATHS}${alternativesSection(alternatives)}`
}
