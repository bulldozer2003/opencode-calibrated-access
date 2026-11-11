import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "fs"
import { join } from "path"
import {
  CORPUS_CATEGORIES,
  CORPUS_EXPECTED,
  loadCorpus,
  validateCorpusEntry,
  type CorpusEntry,
} from "../benchmarks/corpus-schema.ts"

const CORPUS_DIR = join(import.meta.dir, "..", "benchmarks", "corpus")
const SCHEMA_PATH = join(import.meta.dir, "..", "benchmarks", "corpus.schema.json")

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
