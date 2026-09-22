import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { writeDiagnostic, describeError, failureCategory } from "../src/diagnostics.ts"
import { existsSync, unlinkSync, readFileSync } from "fs"

const testPath = "/tmp/calibrated-access-test.jsonl"

beforeAll(() => {
  if (existsSync(testPath)) unlinkSync(testPath)
})

afterAll(() => {
  if (existsSync(testPath)) unlinkSync(testPath)
})

describe("writeDiagnostic", () => {
  test("appends a JSON line", () => {
    writeDiagnostic(testPath, { event: "test", value: 42 })
    const line = readFileSync(testPath, "utf-8").trim()
    const parsed = JSON.parse(line)
    expect(parsed.event).toBe("test")
    expect(parsed.value).toBe(42)
  })

  test("appends multiple lines", () => {
    writeDiagnostic(testPath, { event: "a" })
    writeDiagnostic(testPath, { event: "b" })
    const lines = readFileSync(testPath, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(3)
  })

  test("is a no-op when path is undefined", () => {
    writeDiagnostic(undefined, { event: "should-not-appear" })
  })
})

describe("describeError", () => {
  test("describes an Error", () => {
    const result = describeError(new Error("something broke"))
    expect(result.name).toBe("Error")
    expect(result.message).toBe("something broke")
  })

  test("describes a string", () => {
    const result = describeError("oops")
    expect(result.name).toBe("string")
    expect(result.message).toBe("oops")
  })
})

describe("failureCategory", () => {
  test("timeout for AbortError", () => {
    const error = new DOMException("timed out", "AbortError")
    expect(failureCategory(error)).toBe("timeout")
  })

  test("timeout for AbortSignal timeout", () => {
    const error = new Error("The operation was aborted due to timeout")
    expect(failureCategory(error)).toBe("timeout")
  })

  test("unknown for other errors", () => {
    expect(failureCategory(new Error("network error"))).toBe("unknown")
  })
})