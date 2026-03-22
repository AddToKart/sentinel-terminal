import path from 'node:path'

import type { ProcessMetrics, ProjectState, SessionCommandEntry } from '@shared/types'

export function emptyMetrics(): ProcessMetrics {
  return {
    cpuPercent: 0,
    memoryMb: 0,
    threadCount: 0,
    handleCount: 0,
    processCount: 0
  }
}

export function createEmptyProject(): ProjectState {
  return {
    isGitRepo: false,
    tree: []
  }
}

export function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

export function sanitizeSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'agent'
}

export function createToken(): string {
  return Math.random().toString(36).slice(2, 8)
}

export function createTimestamp(): string {
  const now = new Date()
  const parts = [
    now.getFullYear().toString(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ]

  return parts.join('')
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function normalizeRelativePath(relativePath: string): string {
  return path
    .normalize(relativePath.trim().replace(/\//g, path.sep))
    .replace(/^[\\/]+/, '')
}

export function normalizeSessionPaths(_projectRoot: string, relativePaths: string[]): string[] {
  return [...new Set(relativePaths.map(normalizeRelativePath).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  )
}

export function arrayEquals(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  return left.every((value, index) => value === right[index])
}

export function createHistoryEntry(
  command: string,
  source: SessionCommandEntry['source']
): SessionCommandEntry {
  return {
    id: `${createTimestamp()}-${createToken()}`,
    command,
    timestamp: Date.now(),
    source
  }
}

export function parseGitStatusOutput(raw: string): string[] {
  const entries = raw.split('\0').filter(Boolean)
  const modifiedPaths: string[] = []

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.length < 4) {
      continue
    }

    const status = entry.slice(0, 2)
    const primaryPath = entry.slice(3).trim()

    if (!primaryPath) {
      continue
    }

    if (status.includes('R') || status.includes('C')) {
      const renamedPath = entries[index + 1]?.trim()
      if (renamedPath) {
        modifiedPaths.push(renamedPath)
        index += 1
        continue
      }
    }

    modifiedPaths.push(primaryPath)
  }

  return [...new Set(modifiedPaths)]
}
