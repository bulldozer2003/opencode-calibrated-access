import { describe, expect, test } from "bun:test"
import { normalizeAskedEvent, normalizeRepliedEvent, isPluginContinuation, lastAssistantAgent, latestUserRouting } from "../src/context.ts"

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

  test("normalizes the 1.19 stable permission.asked payload", () => {
    const event = {
      type: "permission.asked",
      properties: {
        id: "per_1",
        sessionID: "sess1",
        permission: "bash",
        patterns: ["ls"],
        always: [],
      },
    }
    expect(normalizeAskedEvent(event)).toEqual({
      id: "per_1",
      sessionID: "sess1",
      action: "bash",
      resources: ["ls"],
      always: [],
      protocol: "stable",
    })
  })

  test("returns null for 1.19 permission.asked with non-string patterns", () => {
    const event = {
      type: "permission.asked",
      properties: { id: "per_2", sessionID: "sess1", permission: "bash", patterns: [123], always: [] },
    }
    expect(normalizeAskedEvent(event)).toBeNull()
  })

  test("returns null for 1.19 permission.asked without a permission name", () => {
    const event = {
      type: "permission.asked",
      properties: { id: "per_3", sessionID: "sess1", patterns: ["ls"], always: [] },
    }
    expect(normalizeAskedEvent(event)).toBeNull()
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

describe("lastAssistantAgent", () => {
  test("reads the agent from the flat message shape", () => {
    expect(lastAssistantAgent([{ role: "assistant", agent: "planner" }])).toBe("planner")
  })

  test("reads the agent from the info/parts message shape", () => {
    expect(lastAssistantAgent([{ info: { role: "assistant", agent: "builder" }, parts: [] }])).toBe("builder")
  })

  test("returns the last assistant agent when several are present", () => {
    expect(
      lastAssistantAgent([
        { role: "assistant", agent: "planner" },
        { info: { role: "user" }, parts: [] },
        { info: { role: "assistant", agent: "builder" }, parts: [] },
      ]),
    ).toBe("builder")
  })

  test("skips synthetic continuation messages in the info/parts shape", () => {
    const continuation = "[Calibrated Access] The requested action was blocked: too risky"
    expect(
      lastAssistantAgent([
        { role: "assistant", agent: "planner" },
        { info: { role: "assistant", agent: "synthetic" }, parts: [{ type: "text", text: continuation }] },
      ]),
    ).toBe("planner")
  })

  test("skips synthetic continuation messages in the flat shape", () => {
    const continuation = "[Calibrated Access] The requested action was blocked: too risky"
    expect(
      lastAssistantAgent([
        { role: "assistant", agent: "planner" },
        { role: "assistant", agent: "synthetic", text: continuation },
      ]),
    ).toBe("planner")
  })

  test("returns undefined when no assistant agent is present", () => {
    expect(lastAssistantAgent([{ info: { role: "user" }, parts: [] }, { role: "system" }])).toBeUndefined()
  })

  test("returns undefined for an empty message list", () => {
    expect(lastAssistantAgent([])).toBeUndefined()
  })
})

describe("latestUserRouting", () => {
  test("reads routing from the flat user message shape", () => {
    expect(
      latestUserRouting([
        { role: "user", agent: "planner", model: { providerID: "anthropic", modelID: "claude-sonnet", variant: "high" } },
      ]),
    ).toEqual({ agent: "planner", model: { providerID: "anthropic", modelID: "claude-sonnet" }, variant: "high" })
  })

  test("reads routing from the info/parts user message shape", () => {
    expect(
      latestUserRouting([{ info: { role: "user", agent: "builder", model: { providerID: "openai", modelID: "gpt-5" } }, parts: [] }]),
    ).toEqual({ agent: "builder", model: { providerID: "openai", modelID: "gpt-5" } })
  })

  test("normalizes a model {providerID, id} pair to {providerID, modelID}", () => {
    expect(latestUserRouting([{ info: { role: "user", model: { providerID: "openai", id: "gpt-5" } }, parts: [] }])).toEqual({
      model: { providerID: "openai", modelID: "gpt-5" },
    })
  })

  test("returns only the fields a user message actually carries", () => {
    expect(latestUserRouting([{ role: "user", agent: "planner" }])).toEqual({ agent: "planner" })
    expect(latestUserRouting([{ role: "user", model: { providerID: "openai", modelID: "gpt-5", variant: "low" } }])).toEqual({
      model: { providerID: "openai", modelID: "gpt-5" },
      variant: "low",
    })
  })

  test("scans in reverse and returns the latest user routing", () => {
    expect(
      latestUserRouting([
        { info: { role: "user", agent: "planner" }, parts: [] },
        { info: { role: "assistant", agent: "ignored" }, parts: [] },
        { role: "user", agent: "builder" },
      ]),
    ).toEqual({ agent: "builder" })
  })

  test("skips synthetic continuation messages in the info/parts shape", () => {
    const continuation = "[Calibrated Access] The requested action was blocked: too risky"
    expect(
      latestUserRouting([
        { role: "user", agent: "planner" },
        { info: { role: "user" }, parts: [{ type: "text", text: continuation }] },
      ]),
    ).toEqual({ agent: "planner" })
  })

  test("skips synthetic continuation messages in the flat shape", () => {
    const continuation = "[Calibrated Access] The requested action was blocked: too risky"
    expect(
      latestUserRouting([
        { role: "user", agent: "planner" },
        { type: "user", agent: "synthetic", text: continuation },
      ]),
    ).toEqual({ agent: "planner" })
  })

  test("returns an empty object when only synthetic continuations are present", () => {
    const continuation = "[Calibrated Access] The requested action was blocked: too risky"
    expect(latestUserRouting([{ info: { role: "user" }, parts: [{ type: "text", text: continuation }] }])).toEqual({})
  })

  test("returns an empty object for an empty message list", () => {
    expect(latestUserRouting([])).toEqual({})
  })

  test("returns an empty object when no user message is present", () => {
    expect(latestUserRouting([{ info: { role: "assistant", agent: "planner" }, parts: [] }])).toEqual({})
  })
})