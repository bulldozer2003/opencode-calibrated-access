import { CALIBRATED_PREFIX } from "./types.ts"

export function buildContinuationMessage(reason: string, resources: string[]): string {
  const command = resources.join(" && ")
  return `${CALIBRATED_PREFIX} ${reason} (blocked: ${command}). Do not retry the exact blocked action. Continue the task using a safer alternative when possible; ask the user only if no useful safe path remains.`
}