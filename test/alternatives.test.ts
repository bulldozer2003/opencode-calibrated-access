import { describe, expect, test } from "bun:test"
import { alternativesFor } from "../src/alternatives.ts"

describe("alternativesFor", () => {
  test("returns at least three actionable alternatives for secret_exposure", () => {
    const alternatives = alternativesFor("secret_exposure")
    expect(alternatives.length).toBeGreaterThanOrEqual(3)
    for (const item of alternatives) {
      expect(item.length).toBeGreaterThan(0)
    }
  })

  test("never instructs printing the secret", () => {
    const alternatives = alternativesFor("secret_exposure").join(" ")
    expect(alternatives).not.toMatch(/\becho \$/)
    expect(alternatives).not.toMatch(/\bprintenv\b/)
  })

  test("returns an empty list for an unknown reason code", () => {
    expect(alternativesFor("something_else")).toEqual([])
  })

  test("returns a fresh copy so callers cannot mutate the registry", () => {
    const first = alternativesFor("secret_exposure")
    first.push("mutated")
    expect(alternativesFor("secret_exposure")).not.toContain("mutated")
  })
})
