import { describe, expect, test } from "bun:test"
import { SessionApprovalCache } from "../src/cache.ts"

describe("SessionApprovalCache", () => {
  test("starts empty", () => {
    const cache = new SessionApprovalCache()
    expect(cache.has("ses_root", "bash", ["git status"])).toBe(false)
  })

  test("adds and retrieves", () => {
    const cache = new SessionApprovalCache()
    cache.add("ses_root", "bash", ["git status"])
    expect(cache.has("ses_root", "bash", ["git status"])).toBe(true)
  })

  test("different session does not match", () => {
    const cache = new SessionApprovalCache()
    cache.add("ses_root", "bash", ["git status"])
    expect(cache.has("ses_other", "bash", ["git status"])).toBe(false)
  })

  test("different action does not match", () => {
    const cache = new SessionApprovalCache()
    cache.add("ses_root", "bash", ["git status"])
    expect(cache.has("ses_root", "external_directory", ["git status"])).toBe(false)
  })

  test("different patterns do not match", () => {
    const cache = new SessionApprovalCache()
    cache.add("ses_root", "bash", ["git status"])
    expect(cache.has("ses_root", "bash", ["git diff"])).toBe(false)
  })

  test("order of patterns does not matter", () => {
    const cache = new SessionApprovalCache()
    cache.add("ses_root", "bash", ["git status", "git diff"])
    expect(cache.has("ses_root", "bash", ["git diff", "git status"])).toBe(true)
  })
})