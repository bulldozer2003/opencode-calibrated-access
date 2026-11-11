import { readFileSync } from "fs"
import { summarizeDiagnostics, formatSummary } from "../src/diagnostics-sum.ts"

const path = process.argv[2]
if (!path) {
  console.error("Usage: bun run scripts/sum-diagnostics.ts <diagnostics.jsonl>")
  process.exit(1)
}

let raw: string
try {
  raw = readFileSync(path, "utf-8")
} catch (error) {
  console.error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

console.log(formatSummary(summarizeDiagnostics(raw.split("\n"))))
