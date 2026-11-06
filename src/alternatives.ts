const ALTERNATIVES: Record<string, string[]> = {
  secret_exposure: [
    "Use gh auth login / git credential fill instead of inlining tokens.",
    "Load the key from a .env file without printing it (e.g. source into the process env, never echo).",
    "Pass secrets via stdin redirection (< file) or a netrc/credential helper instead of command-line arguments.",
    'To verify a secret exists, check exit status (test -n "$VAR") instead of printing it.',
  ],
}

export function alternativesFor(reasonCode: string): string[] {
  return [...(ALTERNATIVES[reasonCode] ?? [])]
}

export function alternativesSection(alternatives: string[] | undefined): string {
  if (!alternatives || alternatives.length === 0) return ""
  return `\n\nSafer alternatives:\n${alternatives.map((item) => `- ${item}`).join("\n")}`
}
