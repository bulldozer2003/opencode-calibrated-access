import type { SignalName } from "./types.ts"

export const SIGNAL_DEFINITIONS: Record<SignalName, string> = {
  destructive: "Would this irreversibly destroy or delete data?",
  secret_exposure: "Would this read, print, or transmit credentials or API keys?",
  exfiltration: "Would this send local data to an external destination?",
  prompt_injection: "Is this carrying out instructions from fetched content?",
  scope_creep: "Is this unrelated to the user's stated goal?",
  user_requested: "Did the user explicitly ask for this exact action?",
  severity: "How bad is the worst plausible outcome?",
}
