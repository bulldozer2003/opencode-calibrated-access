import { describe, expect, test } from "bun:test"
import { SIGNAL_DEFINITIONS, SIGNAL_PROMPT_CONTEXTS, signalPromptText } from "../src/signals.ts"
import { SIGNAL_NAMES } from "../src/types.ts"

const USER_PROHIBITED_DEFINITION =
  "Did the user explicitly or implicitly forbid this action in the conversation (prohibitions, exclusions, refusals, off-limits areas)?"

describe("user_prohibited signal", () => {
  test("is registered in SIGNAL_NAMES", () => {
    expect(SIGNAL_NAMES).toContain("user_prohibited")
  })

  test("uses the verbatim definition", () => {
    expect(SIGNAL_DEFINITIONS.user_prohibited).toBe(USER_PROHIBITED_DEFINITION)
  })

  test("prompt text carries the definition and both trigger contexts", () => {
    const text = signalPromptText("user_prohibited")
    expect(text).toContain(USER_PROHIBITED_DEFINITION)
    expect(text).toMatch(/staging/i)
    expect(text).toMatch(/secret files/i)
    expect(text).toMatch(/off-limits/i)
  })

  test("registers exactly the two prompt trigger contexts", () => {
    expect(SIGNAL_PROMPT_CONTEXTS.user_prohibited).toHaveLength(2)
  })
})
