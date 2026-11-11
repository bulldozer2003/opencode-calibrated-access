export class SessionApprovalCache {
  private store = new Set<string>()
  private appeals = new Set<string>()

  has(sessionID: string, action: string, patterns: string[]): boolean {
    return this.store.has(key(sessionID, action, patterns))
  }

  add(sessionID: string, action: string, patterns: string[]): void {
    this.store.add(key(sessionID, action, patterns))
  }

  hasAppeal(sessionID: string, action: string, patterns: string[]): boolean {
    return this.appeals.has(key(sessionID, action, patterns))
  }

  markAppeal(sessionID: string, action: string, patterns: string[]): void {
    this.appeals.add(key(sessionID, action, patterns))
  }

  clear(): void {
    this.store.clear()
    this.appeals.clear()
  }
}

function key(sessionID: string, action: string, patterns: string[]): string {
  const sorted = [...patterns].sort()
  return `${sessionID}::${action}::${JSON.stringify(sorted)}`
}