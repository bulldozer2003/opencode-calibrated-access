import type { Decision, DeterministicFinding, ReviewInput } from "./types.ts"
import { alternativesFor } from "./alternatives.ts"

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

const SECRET_FILE_BASENAMES = /^(?:\.env(?:\.[A-Za-z0-9._-]+)?|\.netrc|\.npmrc|\.pypirc|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i
const SECRET_FILE_SUFFIX = /\.(?:pem|key)$/i
const SECRET_FILE_CONFIG_PATHS = /(?:^|\/)(?:\.aws\/credentials|\.docker\/config\.json)$/i
const READ_UTILITIES = new Set(["cat", "head", "tail", "less", "more", "bat", "grep", "rg", "awk", "sed", "strings"])
const SOURCED_PREFIX = /^\s*(?:\.|source)\s/

export type SecretExposure = { reasonCode: "secret_exposure"; reason: string }

export function detectSecretExposure(command: string): SecretExposure | null {
  const effective = withoutProcessSubstitution(command)
  const secretVars = secretVarNames(effective)

  if (isPrintCommandOfSecret(effective, secretVars)) {
    return exposure(`env var ${secretVars[0] ?? "unknown"}`, "stdout/arguments")
  }

  const secretFile = secretFileRead(command)
  if (secretFile) {
    return {
      reasonCode: "secret_exposure",
      reason: `This command would read ${secretFile} into output, exposing its secrets to the model. Source it into a subshell instead (. .env && cmd).`,
    }
  }

  const stagedFile = secretFileStaged(command)
  if (stagedFile) {
    return {
      reasonCode: "secret_exposure",
      reason: `This would commit a secret file (${stagedFile}) into version control. Add it to .gitignore and use a credential store.`,
    }
  }

  const redirected = secretVarRedirected(effective)
  if (redirected) {
    return exposure(`env var ${redirected}`, "a file or downstream command")
  }

  if (isEnvironmentDump(effective)) {
    return {
      reasonCode: "secret_exposure",
      reason:
        "This command would dump the process environment (which may hold secrets) to a file or network command. Redirect only the specific non-secret values you need.",
    }
  }

  const networkSecret = networkCommandWithSecret(effective, secretVars)
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

function withoutProcessSubstitution(command: string): string {
  return command.replace(/<\([^()]*\)/g, " ")
}

function shellTokens(command: string): string[] {
  return command
    .split(/\s+/)
    .map((token) => token.replace(/^['"]+|['"]+$/g, "").replace(/[;|&]+$/, ""))
    .filter((token) => token.length > 0)
}

function isSecretFilePath(token: string): boolean {
  const cleaned = token.replace(/^['"]+|['"]+$/g, "")
  if (!cleaned || cleaned.startsWith("-")) return false
  const basename = cleaned.split("/").pop() ?? cleaned
  return SECRET_FILE_BASENAMES.test(basename) || SECRET_FILE_SUFFIX.test(basename) || SECRET_FILE_CONFIG_PATHS.test(cleaned)
}

function secretFileRead(command: string): string | undefined {
  if (SOURCED_PREFIX.test(command)) return undefined
  const tokens = shellTokens(withoutProcessSubstitution(command))
  if (!tokens.some((token) => READ_UTILITIES.has(token.toLowerCase()))) return undefined
  return tokens.find(isSecretFilePath)
}

function secretFileStaged(command: string): string | undefined {
  const tokens = shellTokens(withoutProcessSubstitution(command))
  const git = tokens.findIndex((token) => token.toLowerCase() === "git")
  if (git === -1 || tokens[git + 1]?.toLowerCase() !== "add") return undefined
  return tokens.slice(git + 2).find(isSecretFilePath)
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

  const hard = fastFindings({ action: input.request.action, resources: input.request.resources }).find(
    (finding) => finding.severity === "hard",
  )
  return hard ? hardFindingDecision(hard) : null
}

/**
 * Context-free deterministic findings. Catastrophic deletes stay `hard` (always
 * enforced); secret exposure is a `caution` handed to the judge so intent can be
 * weighed. No allow path: every non-hard command reaches the model.
 */
export function fastFindings(request: { action: string; resources: string[] }): DeterministicFinding[] {
  if (request.action !== "bash") return []

  const command = request.resources.join(" && ").trim()
  if (!command) return []

  const findings: DeterministicFinding[] = []

  if (isRootOrHomeRecursiveDelete(command)) {
    findings.push({
      code: "catastrophic_delete",
      severity: "hard",
      message: "Recursively deleting the filesystem root or home directory would cause catastrophic data loss.",
    })
  }

  const exposure = detectSecretExposure(command)
  if (exposure) {
    findings.push({
      code: "secret_exposure",
      severity: "caution",
      message: `caution: command matches a secret-file-read pattern (${exposure.reason})`,
    })
  }

  return findings
}

export function hardFindingDecision(finding: DeterministicFinding): Decision {
  return { kind: "deny", reasonCode: finding.code, reason: finding.message, alternatives: alternativesFor(finding.code) }
}

function commandText(input: ReviewInput): string {
  return input.request.resources.join(" && ").trim()
}

function isRootOrHomeRecursiveDelete(command: string): boolean {
  return /(?:^|\s)rm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+(?:--\s+)?(?:["']?\/["']?|["']?~["']?|["']?\$HOME["']?)(?:\s|$)/i.test(command)
}

const PROHIBITION_PHRASE =
  /\b(?:explicitly prohibit|(?:do not|don't|never|must not|mustn't)\s+(?:run|execute|use|access)|forbidden|off-limits)\b/i

function explicitlyProhibited(input: ReviewInput): boolean {
  const recent = input.context.userMessages.slice(-3).filter((message) => PROHIBITION_PHRASE.test(message))
  if (recent.length === 0) return false

  const command = commandText(input)
  if (input.request.action === "bash" && command && recent.some((message) => message.includes(command))) {
    return true
  }

  if (input.request.action !== "external_directory") return false
  return recent.some((message) =>
    input.request.resources.some((resource) => {
      const prefix = resource.replace(/[?*].*$/, "")
      return prefix.length > 1 && message.includes(prefix)
    }),
  )
}

function deny(reasonCode: string, reason: string): Decision {
  return { kind: "deny", reasonCode, reason }
}