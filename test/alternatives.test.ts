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

  test("covers sourcing secret files and keeping them out of version control", () => {
    const alternatives = alternativesFor("secret_exposure").join(" ").toLowerCase()
    expect(alternatives).toMatch(/source|subshell/)
    expect(alternatives).toMatch(/gitignore|credential store/)
  })

  test("returns an empty list for an unknown reason code", () => {
    expect(alternativesFor("something_else")).toEqual([])
  })

  test("provides explicit-path staging alternatives for signal_block_user_prohibited", () => {
    const alternatives = alternativesFor("signal_block_user_prohibited")
    expect(alternatives).toContain("Stage files individually (git add <path>) after confirming none are secret-bearing.")
    expect(alternatives).toContain("Run git status first and add only the intended paths.")
  })

  test("returns a fresh copy so callers cannot mutate the registry", () => {
    const first = alternativesFor("secret_exposure")
    first.push("mutated")
    expect(alternativesFor("secret_exposure")).not.toContain("mutated")
  })
})
