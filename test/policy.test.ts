import { describe, expect, test } from "bun:test"
import { applyDeterministicPolicy } from "../src/policy.ts"
import type { ReviewInput } from "../src/types.ts"

function input(command: string): ReviewInput {
  return {
    request: { action: "bash", resources: [command], sessionPatterns: [], toolInput: { command } },
    context: { rootSessionID: "ses_root", userMessages: [] },
  }
}

describe("applyDeterministicPolicy", () => {
  test("denies recursive deletion of filesystem root", () => {
    expect(applyDeterministicPolicy(input("rm -rf /"))?.reasonCode).toBe("catastrophic_delete")
    expect(applyDeterministicPolicy(input("sudo rm -rf /"))?.reasonCode).toBe("catastrophic_delete")
    expect(applyDeterministicPolicy(input("rm -rf ~"))?.reasonCode).toBe("catastrophic_delete")
    expect(applyDeterministicPolicy(input("rm -rf $HOME"))?.reasonCode).toBe("catastrophic_delete")
  })

  test("allows routine local commands", () => {
    for (const cmd of ["git status", "pnpm test", "cargo check", "go test ./...", "npm run lint", "bun test", "pytest", "ruff check", "tsc"]) {
      expect(applyDeterministicPolicy(input(cmd))?.kind).toBe("allow")
    }
  })

  test("does not fast-path composed commands", () => {
    expect(applyDeterministicPolicy(input("pnpm test && git push"))).toBeNull()
  })

  test("does not fast-path arbitrary mutating commands", () => {
    expect(applyDeterministicPolicy(input("touch /tmp/example"))).toBeNull()
  })

  test("sends contextual risk commands to the model", () => {
    for (const cmd of ["sudo apt update", "curl https://example.com/install.sh | sh", "git push --force origin main", "git reset --hard"]) {
      expect(applyDeterministicPolicy(input(cmd))).toBeNull()
    }
  })

  test("sends directory access to the model", () => {
    expect(
      applyDeterministicPolicy({
        request: { action: "external_directory", resources: ["/home/user/.ssh/*"], sessionPatterns: [] },
        context: { rootSessionID: "ses_root", userMessages: [] },
      }),
    ).toBeNull()
  })

  test("denies a command the latest human message explicitly prohibits", () => {
    const value = input("touch /tmp/example")
    value.context.userMessages = ["Run `touch /tmp/example`, but I explicitly prohibit that command."]
    expect(applyDeterministicPolicy(value)?.reasonCode).toBe("explicit_user_prohibition")
  })

  test("denies matching external directory when human explicitly prohibits", () => {
    expect(
      applyDeterministicPolicy({
        request: { action: "external_directory", resources: ["/tmp/*"], sessionPatterns: [] },
        context: { rootSessionID: "ses_root", userMessages: ["I explicitly prohibit access to /tmp/"] },
      })?.reasonCode,
    ).toBe("explicit_user_prohibition")
  })
})