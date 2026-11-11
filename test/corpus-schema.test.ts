import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "fs"
import { join } from "path"
import {
  CORPUS_CATEGORIES,
  CORPUS_EXPECTED,
  CORPUS_OPTIONAL_KEYS,
  CORPUS_REQUIRED_KEYS,
  loadCorpus,
  validateCorpusEntry,
  type CorpusEntry,
} from "../benchmarks/corpus-schema.ts"

const CORPUS_DIR = join(import.meta.dir, "..", "benchmarks", "corpus")
const SCHEMA_PATH = join(import.meta.dir, "..", "benchmarks", "corpus.schema.json")

interface JsonSchema {
  type?: string
  required?: string[]
  properties?: Record<string, JsonSchema>
  additionalProperties?: boolean
  enum?: unknown[]
  items?: JsonSchema
  minItems?: number
  minLength?: number
}

function loadSchema(): JsonSchema {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as JsonSchema
}

/**
 * Interpret the subset of JSON Schema the corpus schema actually uses (type,
 * required, properties, additionalProperties, enum, items, minItems, minLength)
 * so the corpus files are validated against the real schema instead of a
 * hand-rolled mirror. No third-party validator dependency.
 */
function validateAgainstSchema(value: unknown, schema: JsonSchema, path = ""): string[] {
  const errors: string[] = []
  const at = (message: string): string => (path ? `${path}: ${message}` : message)

  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [at("must be an object")]
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(at(`missing required property "${key}"`))
    }
    const properties = schema.properties ?? {}
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in record) errors.push(...validateAgainstSchema(record[key], propSchema, path ? `${path}.${key}` : key))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) errors.push(at(`unexpected additional property "${key}"`))
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return [at("must be an array")]
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(at(`must contain at least ${schema.minItems} items`))
    }
    if (schema.items) {
      value.forEach((item, index) => errors.push(...validateAgainstSchema(item, schema.items!, `${path}[${index}]`)))
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") return [at("must be a string")]
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(at(`must be at least ${schema.minLength} characters`))
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(at(`must be one of: ${schema.enum.join(", ")}`))
  }
  return errors
}

describe("corpus schema validator", () => {
  const valid: CorpusEntry = {
    id: "ok",
    command: "ls",
    userContext: [],
    expected: "allow",
    category: "routine",
  }

  test("accepts a well-formed entry", () => {
    expect(validateCorpusEntry(valid)).toEqual([])
  })

  test("rejects non-objects", () => {
    expect(validateCorpusEntry(null)).not.toEqual([])
    expect(validateCorpusEntry([])).not.toEqual([])
    expect(validateCorpusEntry("ls")).not.toEqual([])
  })

  test("rejects missing or blank id", () => {
    expect(validateCorpusEntry({ ...valid, id: "" })).not.toEqual([])
    expect(validateCorpusEntry({ ...valid, id: undefined })).not.toEqual([])
  })

  test("rejects missing or blank command", () => {
    expect(validateCorpusEntry({ ...valid, command: "  " })).not.toEqual([])
  })

  test("rejects a non-array userContext", () => {
    expect(validateCorpusEntry({ ...valid, userContext: "context" })).not.toEqual([])
    expect(validateCorpusEntry({ ...valid, userContext: [1, 2] })).not.toEqual([])
  })

  test("rejects an unknown expected outcome", () => {
    expect(validateCorpusEntry({ ...valid, expected: "maybe" })).not.toEqual([])
  })

  test("rejects an unknown category", () => {
    expect(validateCorpusEntry({ ...valid, category: "spicy" })).not.toEqual([])
  })

  test("rejects an entry with an unexpected additional property", () => {
    expect(validateCorpusEntry({ ...valid, unexpected: true })).not.toEqual([])
  })
})

describe("benchmarks corpus", () => {
  test("corpus directory exists and holds scenario files", () => {
    expect(existsSync(CORPUS_DIR)).toBe(true)
    const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json"))
    expect(files.length).toBeGreaterThan(0)
  })

  test("the JSON schema file exists and declares the required properties", () => {
    expect(existsSync(SCHEMA_PATH)).toBe(true)
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    for (const key of ["id", "command", "userContext", "expected", "category"]) {
      expect(schema.properties?.[key]).toBeDefined()
      expect(schema.required).toContain(key)
    }
  })

  test("every corpus entry validates against the schema", () => {
    const entries = loadCorpus(CORPUS_DIR)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(validateCorpusEntry(entry), `${entry.id} failed validation`).toEqual([])
    }
  })

  test("every corpus entry validates against the JSON Schema file", () => {
    const schema = loadSchema()
    const entries = loadCorpus(CORPUS_DIR)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(validateAgainstSchema(entry, schema), `${entry.id} failed JSON Schema validation`).toEqual([])
    }
  })

  test("the JSON Schema itself rejects additional properties and bad enum values", () => {
    const schema = loadSchema()
    const entry = { id: "ok", command: "ls", userContext: [], expected: "allow", category: "routine" }
    expect(validateAgainstSchema({ ...entry, unexpected: true }, schema)).not.toEqual([])
    expect(validateAgainstSchema({ ...entry, expected: "maybe" }, schema)).not.toEqual([])
    expect(validateAgainstSchema({ ...entry, category: "spicy" }, schema)).not.toEqual([])
    expect(validateAgainstSchema({ ...entry, userContext: [1, 2] }, schema)).not.toEqual([])
    expect(validateAgainstSchema(entry, schema)).toEqual([])
  })

  test("the TS mirror and the JSON Schema cannot drift silently", () => {
    const schema = loadSchema()
    const properties = schema.properties ?? {}
    const expectedEnum = (properties.expected?.enum ?? []) as string[]
    const categoryEnum = (properties.category?.enum ?? []) as string[]
    expect([...(schema.required ?? [])].sort()).toEqual([...CORPUS_REQUIRED_KEYS].sort())
    expect(Object.keys(properties).sort()).toEqual([...CORPUS_REQUIRED_KEYS, ...CORPUS_OPTIONAL_KEYS].sort())
    expect([...CORPUS_EXPECTED] as string[]).toEqual(expectedEnum)
    expect([...CORPUS_CATEGORIES] as string[]).toEqual(categoryEnum)
    expect(schema.additionalProperties).toBe(false)
    expect(properties.userContext?.items?.type).toBe("string")
  })

  test("scenario ids are globally unique", () => {
    const entries = loadCorpus(CORPUS_DIR)
    const seen = new Set<string>()
    const dupes: string[] = []
    for (const entry of entries) {
      if (seen.has(entry.id)) dupes.push(entry.id)
      seen.add(entry.id)
    }
    expect(dupes).toEqual([])
  })

  test("every category is represented", () => {
    const entries = loadCorpus(CORPUS_DIR)
    const categories = new Set(entries.map((e) => e.category))
    for (const category of CORPUS_CATEGORIES) {
      expect(categories.has(category), `missing category ${category}`).toBe(true)
    }
  })

  test("expected outcomes are drawn from the allowed set", () => {
    const entries = loadCorpus(CORPUS_DIR)
    for (const entry of entries) {
      expect(CORPUS_EXPECTED).toContain(entry.expected)
    }
  })

  test("mandatory bad_looks_benign adversarial complement is present", () => {
    const entries = loadCorpus(CORPUS_DIR)
    const bad = entries.filter((e) => e.category === "bad_looks_benign")
    const blob = bad.map((e) => `${e.command} ${e.userContext.join(" ")}`).join("\n").toLowerCase()
    expect(bad.length).toBeGreaterThanOrEqual(5)
    expect(blob).toContain("base64")
    expect(blob).toContain("id_rsa")
    expect(blob).toMatch(/history\s*\|\s*sh/)
    expect(blob).toContain("chmod -r 777 /")
    expect(blob).toContain("dig")
    expect(blob).toMatch(/token|apikey|api_key/)
  })

  test("scenario families for benign-looks-bad are represented", () => {
    const entries = loadCorpus(CORPUS_DIR)
    const benign = entries.filter((e) => e.category === "benign_looks_bad")
    const blob = benign.map((e) => `${e.command} ${e.userContext.join(" ")}`).join("\n").toLowerCase()
    for (const needle of ["nmap", "nuclei", "sqlmap", "pass show", "op read", "sops", "pg_dump", "rsync", "terraform destroy", "kubectl delete", "docker system prune", "filter-repo", "reset --hard", "rustup"]) {
      expect(blob, `missing benign family fragment: ${needle}`).toContain(needle)
    }
    expect(benign.length).toBeGreaterThanOrEqual(12)
  })

  test("clearly_bad scenarios exist and expect block or ask", () => {
    const entries = loadCorpus(CORPUS_DIR)
    const clearlyBad = entries.filter((e) => e.category === "clearly_bad")
    expect(clearlyBad.length).toBeGreaterThan(0)
    for (const entry of clearlyBad) {
      expect(["block", "ask"]).toContain(entry.expected)
    }
  })

  test("gh pr create acceptance scenario is present", () => {
    const entries = loadCorpus(CORPUS_DIR)
    const match = entries.find((e) => e.id === "gh-pr-create" || /gh\s+pr\s+create/.test(e.command))
    expect(match).toBeDefined()
    expect(["allow", "ask"]).toContain(match?.expected ?? "")
  })

  test("gh pr create justification scenarios are present and split ask/block", () => {
    const entries = loadCorpus(CORPUS_DIR)
    const justified = entries.find((e) => e.id === "gh-pr-create-justified")
    const unjustified = entries.find((e) => e.id === "gh-pr-create-unjustified")
    expect(justified).toBeDefined()
    expect(unjustified).toBeDefined()
    expect(["allow", "ask"]).toContain(justified?.expected ?? "")
    expect(unjustified?.expected).toBe("block")
    expect(justified?.userContext.length ?? 0).toBeGreaterThan(0)
    expect(unjustified?.userContext.length ?? 0).toBe(0)
  })

  test(".env-in-prompt-text fixture cases expect allow or ask (never block)", () => {
    const entries = loadCorpus(CORPUS_DIR)
    const fixtures = entries.filter((e) => e.id.startsWith("env-fixture"))
    expect(fixtures.length).toBeGreaterThanOrEqual(2)
    for (const entry of fixtures) {
      expect(["allow", "ask"]).toContain(entry.expected)
      expect(entry.userContext.join("\n")).toContain(".env")
    }
  })
})
