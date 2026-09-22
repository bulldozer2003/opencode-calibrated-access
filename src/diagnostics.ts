import { appendFileSync } from "fs"

export function writeDiagnostic(path: string | undefined, data: Record<string, unknown>): void {
  if (!path) return
  appendFileSync(path, JSON.stringify(data) + "\n", "utf-8")
}

export function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  return { name: typeof error, message: String(error) }
}

export function failureCategory(error: unknown): "timeout" | "unknown" {
  if (error instanceof DOMException && error.name === "AbortError") return "timeout"
  if (error instanceof Error && /timeout/i.test(error.message)) return "timeout"
  return "unknown"
}