import { describe, expect, test } from "bun:test"
import { normalizeAskedEvent, normalizeRepliedEvent, isPluginContinuation } from "../src/context.ts"

describe("normalizeAskedEvent", () => {
  test("normalizes V2 permission.asked event", () => {
    const event = {
      type: "permission.asked",
      data: {
        id: "perm_1",
        sessionID: "ses_1",
        action: "bash",
        resources: ["git status"],
        always: [],
      },
    }
    const result = normalizeAskedEvent(event)
    expect(result).not.toBeNull()
    expect(result!.id).toBe("perm_1")
    expect(result!.sessionID).toBe("ses_1")
    expect(result!.action).toBe("bash")
    expect(result!.resources).toEqual(["git status"])
    expect(result!.protocol).toBe("v2")
  })

  test("normalizes permission.v2.asked event", () => {
    const event = {
      type: "permission.v2.asked",
      data: {
        id: "perm_2",
        sessionID: "ses_2",
        action: "external_directory",
        resources: ["/tmp/*"],
        always: [],
      },
    }
    const result = normalizeAskedEvent(event)
    expect(result).not.toBeNull()
    expect(result!.id).toBe("perm_2")
    expect(result!.protocol).toBe("v2")
  })

  test("normalizes stable permission.updated event", () => {
    const event = {
      type: "permission.updated",
      properties: {
        id: "perm_3",
        sessionID: "ses_3",
        permission: "bash",
        patterns: ["npm install"],
        always: [],
      },
    }
    const result = normalizeAskedEvent(event)
    expect(result).not.toBeNull()
    expect(result!.action).toBe("bash")
    expect(result!.resources).toEqual(["npm install"])
    expect(result!.protocol).toBe("stable")
  })

  test("returns null for unknown event type", () => {
    expect(normalizeAskedEvent({ type: "unknown", data: {} })).toBeNull()
  })

  test("returns null for missing data", () => {
    expect(normalizeAskedEvent({ type: "permission.asked" })).toBeNull()
  })
})

describe("normalizeRepliedEvent", () => {
  test("normalizes permission.replied event", () => {
    const event = {
      type: "permission.replied",
      properties: {
        sessionID: "ses_1",
        permissionID: "perm_1",
        response: "reject",
      },
    }
    const result = normalizeRepliedEvent(event)
    expect(result).toEqual({ sessionID: "ses_1", requestID: "perm_1" })
  })

  test("normalizes permission.v2.replied event", () => {
    const event = {
      type: "permission.v2.replied",
      data: {
        sessionID: "ses_2",
        requestID: "perm_2",
      },
    }
    const result = normalizeRepliedEvent(event)
    expect(result).toEqual({ sessionID: "ses_2", requestID: "perm_2" })
  })

  test("returns null for unknown type", () => {
    expect(normalizeRepliedEvent({ type: "unknown" })).toBeNull()
  })
})

describe("isPluginContinuation", () => {
  test("detects calibrated access prefix", () => {
    expect(isPluginContinuation("[Calibrated Access] The requested action was blocked: too risky")).toBe(true)
  })

  test("returns false for normal text", () => {
    expect(isPluginContinuation("run git status")).toBe(false)
  })

  test("is whitespace-tolerant", () => {
    expect(isPluginContinuation("  [Calibrated Access] The requested action was blocked: nope")).toBe(true)
  })
})