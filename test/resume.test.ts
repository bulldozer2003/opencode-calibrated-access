import { describe, expect, test } from "bun:test"
import { buildContinuationMessage } from "../src/resume.ts"

describe("buildContinuationMessage", () => {
  test("includes prefix, reason, and do-not-retry instruction", () => {
    const msg = buildContinuationMessage("too risky", ["git push --force"])
    expect(msg).toStartWith("[Calibrated Access] The requested action was blocked:")
    expect(msg).toInclude("too risky")
    expect(msg).toInclude("Do not retry")
  })

  test("mentions the command in the message", () => {
    const msg = buildContinuationMessage("high impact", ["rm -rf /tmp/*"])
    expect(msg).toInclude("rm -rf /tmp/*")
  })

  test("mentions safer alternative instruction", () => {
    const msg = buildContinuationMessage("risky", ["git reset --hard"])
    expect(msg).toInclude("safer alternative")
  })
})