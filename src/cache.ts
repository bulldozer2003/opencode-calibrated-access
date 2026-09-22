export class SessionApprovalCache {
  private store = new Set<string>()

  has(sessionID: string, action: string, patterns: string[]): boolean {
    return this.store.has(key(sessionID, action, patterns))
  }

  add(sessionID: string, action: string, patterns: string[]): void {
    this.store.add(key(sessionID, action, patterns))
  }

  clear(): void {
    this.store.clear()
  }
}

function key(sessionID: string, action: string, patterns: string[]): string {
  const sorted = [...patterns].sort()
  return `${sessionID}::${action}::${JSON.stringify(sorted)}`
}