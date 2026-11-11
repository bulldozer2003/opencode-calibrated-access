import { readdirSync, readFileSync } from "fs"
import { join } from "path"

export const CORPUS_CATEGORIES = ["benign_looks_bad", "bad_looks_benign", "clearly_bad", "routine"] as const
export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number]

export const CORPUS_EXPECTED = ["allow", "ask", "block"] as const
export type CorpusExpected = (typeof CORPUS_EXPECTED)[number]

export const CORPUS_REQUIRED_KEYS = ["id", "command", "userContext", "expected", "category"] as const
export const CORPUS_OPTIONAL_KEYS = ["note"] as const
const CORPUS_ALLOWED_KEYS = new Set<string>([...CORPUS_REQUIRED_KEYS, ...CORPUS_OPTIONAL_KEYS])

export interface CorpusEntry {
  id: string
  command: string
  userContext: string[]
  expected: CorpusExpected
  category: CorpusCategory
  note?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Validate one corpus entry against the benchmark schema. Returns a list of
 * human-readable errors; an empty list means the entry is valid. Pure so it can
 * be unit-tested and reused by the loader and the benches.
 */
export function validateCorpusEntry(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) {
    return ["entry must be an object"]
  }
  for (const key of Object.keys(value)) {
    if (!CORPUS_ALLOWED_KEYS.has(key)) errors.push(`unexpected property "${key}"`)
  }
  if (!isNonEmptyString(value.id)) errors.push("id must be a non-empty string")
  if (!isNonEmptyString(value.command)) errors.push("command must be a non-empty string")
  if (!Array.isArray(value.userContext) || !value.userContext.every((item) => typeof item === "string")) {
    errors.push("userContext must be an array of strings")
  }
  if (typeof value.expected !== "string" || !(CORPUS_EXPECTED as readonly string[]).includes(value.expected)) {
    errors.push(`expected must be one of: ${CORPUS_EXPECTED.join(", ")}`)
  }
  if (typeof value.category !== "string" || !(CORPUS_CATEGORIES as readonly string[]).includes(value.category)) {
    errors.push(`category must be one of: ${CORPUS_CATEGORIES.join(", ")}`)
  }
  if (value.note !== undefined && typeof value.note !== "string") {
    errors.push("note must be a string when present")
  }
  return errors
}

/**
 * Read every `*.json` file in a corpus directory. Each file must hold a JSON
 * array of entries. Throws with the offending filename (and entry id) when a
 * file is malformed, an entry fails schema validation, or ids collide globally.
 */
export function loadCorpus(dir: string): CorpusEntry[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
  const entries: CorpusEntry[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const path = join(dir, file)
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"))
    if (!Array.isArray(parsed)) {
      throw new Error(`${file}: corpus file must contain a JSON array of entries`)
    }
    for (const [index, raw] of parsed.entries()) {
      const errors = validateCorpusEntry(raw)
      if (errors.length > 0) {
        const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : `#${index}`
        throw new Error(`${file}: entry ${id} invalid: ${errors.join("; ")}`)
      }
      const entry = raw as CorpusEntry
      if (seen.has(entry.id)) {
        throw new Error(`${file}: duplicate scenario id "${entry.id}"`)
      }
      seen.add(entry.id)
      entries.push(entry)
    }
  }
  return entries
}
