import type { Decision, ReviewInput } from "./types.ts"
import { alternativesFor } from "./alternatives.ts"

const SHELL_COMPOSITION = /[;&|<>`\n]|\$\(|<\(|>\(/

const SECRET_NAME_PATTERN = /(?:^|_)(?:SECRET|TOKEN|API_?KEY|PASSWORD|PASSWD|CREDENTIALS?|ACCESS_?KEY|PRIVATE_?KEY|AUTH)(?:_|\b)/i
const EXACT_SECRET_NAMES = new Set([
  "API_KEY",
  "GITHUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "TYPESAFE_API_KEY",
  "TOKEN",
])

const TRANSMIT_COMMANDS = /\b(?:curl|wget|nc|netcat|ncat|ssh|scp|rsync|telnet)\b/i

export type SecretExposure = { reasonCode: "secret_exposure"; reason: string }

export function detectSecretExposure(command: string): SecretExposure | null {
  const secretVars = secretVarNames(command)

  if (isPrintCommandOfSecret(command, secretVars)) {
    return exposure(`env var ${secretVars[0] ?? "unknown"}`, "stdout/arguments")
  }

  const redirected = secretVarRedirected(command)
  if (redirected) {
    return exposure(`env var ${redirected}`, "a file or downstream command")
  }

  if (isEnvironmentDump(command)) {
    return {
      reasonCode: "secret_exposure",
      reason:
        "This command would dump the process environment (which may hold secrets) to a file or network command. Redirect only the specific non-secret values you need.",
    }
  }

  const networkSecret = networkCommandWithSecret(command, secretVars)
  if (networkSecret) {
    return exposure(`env var ${networkSecret}`, "a network endpoint")
  }

  if (isGitUrlWithCredentials(command)) {
    return {
      reasonCode: "secret_exposure",
      reason:
        "This command would embed credentials in a git remote URL. Use a credential helper or gh auth login instead.",
    }
  }

  return null
}

function exposure(target: string, destination: string): SecretExposure {
  return {
    reasonCode: "secret_exposure",
    reason: `This command would expose a secret (${target}) to ${destination}. Use a credential store or file redirection instead.`,
  }
}

function secretVarNames(command: string): string[] {
  const names = new Set<string>()
  for (const match of command.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1] ?? match[2]
    if (name && isSecretName(name)) names.add(name)
  }
  return [...names]
}

function isSecretName(name: string): boolean {
  return EXACT_SECRET_NAMES.has(name.toUpperCase()) || SECRET_NAME_PATTERN.test(name)
}

function isPrintCommandOfSecret(command: string, secretVars: string[]): boolean {
  if (/\b(?:echo|printf)\b/.test(command) && secretVars.length > 0) return true
  if (!/\bprintenv\b/.test(command)) return false
  if (secretVars.length > 0) return true
  const bare = command.match(/\bprintenv\s+(?:-\w+\s+)*([A-Za-z_][A-Za-z0-9_]*)/)
  return bare?.[1] ? isSecretName(bare[1]) : false
}

function secretVarRedirected(command: string): string | undefined {
  for (const match of command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\s*(?:>>?|\|)/g)) {
    if (match[1] && isSecretName(match[1])) return match[1]
  }
  return undefined
}

function isEnvironmentDump(command: string): boolean {
  if (!/\b(?:env|printenv|set)\b/.test(command)) return false
  const redirect = /\b(?:env|printenv|set)\b[^>]*>>?\s*\S/
  if (redirect.test(command)) return true
  const pipe = /\b(?:env|printenv|set)\b[^|]*\|\s*([A-Za-z0-9_./-]+)/
  const piped = command.match(pipe)
  return piped?.[1] ? TRANSMIT_COMMANDS.test(piped[1]) : false
}

function networkCommandWithSecret(command: string, secretVars: string[]): string | undefined {
  if (secretVars.length === 0) return undefined
  if (!/\b(?:curl|wget)\b/i.test(command)) return undefined
  if (/authorization\s*:/i.test(command)) return secretVars[0]
  if (/[?&][A-Za-z0-9_]+=[^&\s]*\$\{?[A-Za-z_]/.test(command)) return secretVars[0]
  if (/https?:\/\/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?@/i.test(command)) return secretVars[0]
  return undefined
}

function isGitUrlWithCredentials(command: string): boolean {
  if (!/\bgit\b/.test(command)) return false
  if (/https?:\/\/[^\s"'/@]*:[^\s"'/@]*@/.test(command)) return true
  return /https?:\/\/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?@/.test(command)
}

export function applyDeterministicPolicy(input: ReviewInput): Decision | null {
  if (explicitlyProhibited(input)) {
    return deny("explicit_user_prohibition", "The user explicitly prohibited this action.")
  }
  if (input.request.action !== "bash") return null

  const command = commandText(input)
  if (!command) return null

  if (isRootOrHomeRecursiveDelete(command)) {
    return deny("catastrophic_delete", "Recursively deleting the filesystem root or home directory would cause catastrophic data loss.")
  }

  const exposure = detectSecretExposure(command)
  if (exposure) {
    return { kind: "deny", reasonCode: exposure.reasonCode, reason: exposure.reason, alternatives: alternativesFor(exposure.reasonCode) }
  }

  if (!SHELL_COMPOSITION.test(command) && isRoutineLocalCommand(command)) {
    return { kind: "allow", reasonCode: "routine_local_command", reason: "Runs a routine local inspection or validation command." }
  }

  return null
}

function commandText(input: ReviewInput): string {
  return input.request.resources.join(" && ").trim()
}

function isRootOrHomeRecursiveDelete(command: string): boolean {
  return /(?:^|\s)rm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+(?:--\s+)?(?:["']?\/["']?|["']?~["']?|["']?\$HOME["']?)(?:\s|$)/i.test(command)
}

function isRoutineLocalCommand(command: string): boolean {
  const value = command.trim()
  return [
    /^git\s+(?:status|diff|log|show)(?:\s|$)/,
    /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|build|typecheck|check))(?:\s|$)/,
    /^cargo\s+(?:test|check|build)(?:\s|$)/,
    /^go\s+test(?:\s|$)/,
    /^(?:pytest|ruff\s+check|tsc)(?:\s|$)/,
  ].some((pattern) => pattern.test(value))
}

function explicitlyProhibited(input: ReviewInput): boolean {
  const message = input.context.userMessages.at(-1)
  if (!message || !/\b(?:explicitly prohibit|do not (?:run|execute|use|access)|must not (?:run|execute|use|access))\b/i.test(message)) {
    return false
  }

  const command = commandText(input)
  if (input.request.action === "bash" && command && message.includes(command)) {
    return true
  }

  if (input.request.action !== "external_directory") return false
  return input.request.resources.some((resource) => {
    const prefix = resource.replace(/[?*].*$/, "")
    return prefix.length > 1 && message.includes(prefix)
  })
}

function deny(reasonCode: string, reason: string): Decision {
  return { kind: "deny", reasonCode, reason }
}