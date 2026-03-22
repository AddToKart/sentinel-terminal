import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { ProjectNode } from '@shared/types'

import { IGNORED_DIRECTORIES, TREE_DEPTH, TREE_ENTRY_LIMIT } from './constants'

export async function buildProjectTree(rootPath: string, depth = TREE_DEPTH): Promise<ProjectNode[]> {
  let entries = await fs.readdir(rootPath, { withFileTypes: true })
  entries = entries
    .filter((entry) => {
      if (entry.name.startsWith('.')) {
        return entry.name === '.env' || entry.name === '.github' || !IGNORED_DIRECTORIES.has(entry.name)
      }

      return !IGNORED_DIRECTORIES.has(entry.name)
    })
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1
      }

      return left.name.localeCompare(right.name)
    })
    .slice(0, TREE_ENTRY_LIMIT)

  const nodes = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(rootPath, entry.name)

      if (entry.isDirectory() && depth > 0) {
        try {
          const children = await buildProjectTree(absolutePath, depth - 1)
          return {
            name: entry.name,
            path: absolutePath,
            kind: 'directory' as const,
            children
          }
        } catch {
          return {
            name: entry.name,
            path: absolutePath,
            kind: 'directory' as const
          }
        }
      }

      return {
        name: entry.name,
        path: absolutePath,
        kind: entry.isDirectory() ? ('directory' as const) : ('file' as const)
      }
    })
  )

  return nodes
}
