import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { SessionApplyResult, SessionSyncConflict } from '@shared/types'

import { pathExists, runCommand } from './commands'
import { IGNORED_DIRECTORIES, SANDBOX_LINK_DIRECTORIES } from './constants'
import { normalizeRelativePath } from './helpers'
import type { FileFingerprint, SandboxWorkspaceState } from './types'

function shouldSkipDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name) || SANDBOX_LINK_DIRECTORIES.has(name)
}

function createSignature(size: number, modifiedAtMs: number): string {
  return `${size}:${Math.floor(modifiedAtMs)}`
}

function resolveWorkspaceTarget(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativePath(relativePath)
  const resolved = path.resolve(rootPath, normalizedRelativePath)
  const normalizedRoot = path.resolve(rootPath)
  const rootPrefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`

  if (resolved !== normalizedRoot && !resolved.startsWith(rootPrefix)) {
    throw new Error(`Refusing to access a path outside the workspace: ${relativePath}`)
  }

  return resolved
}

async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath)
  return createHash('sha1').update(content).digest('hex')
}

async function copyProjectTree(
  projectRoot: string,
  workspacePath: string,
  relativeRoot = ''
): Promise<void> {
  const sourceRoot = relativeRoot ? path.join(projectRoot, relativeRoot) : projectRoot
  const targetRoot = relativeRoot ? path.join(workspacePath, relativeRoot) : workspacePath

  await fs.mkdir(targetRoot, { recursive: true })

  const entries = await fs.readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    const nextRelativePath = relativeRoot ? path.join(relativeRoot, entry.name) : entry.name
    const sourcePath = path.join(projectRoot, nextRelativePath)
    const targetPath = path.join(workspacePath, nextRelativePath)

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) {
        continue
      }

      await copyProjectTree(projectRoot, workspacePath, nextRelativePath)
      continue
    }

    if (entry.isSymbolicLink()) {
      try {
        const linkTarget = await fs.readlink(sourcePath)
        const linkStats = await fs.stat(sourcePath)
        await fs.symlink(linkTarget, targetPath, linkStats.isDirectory() ? 'junction' : 'file')
      } catch {
        // Skip unsupported symlinks inside sandbox copies rather than failing the entire workspace.
      }
      continue
    }

    if (entry.isFile()) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.copyFile(sourcePath, targetPath)
    }
  }
}

async function listTrackedFiles(rootPath: string, relativeRoot = ''): Promise<string[]> {
  if (!(await pathExists(rootPath))) {
    return []
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const nextRelativePath = relativeRoot ? path.join(relativeRoot, entry.name) : entry.name
    const absolutePath = path.join(rootPath, entry.name)

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) {
        continue
      }

      files.push(...(await listTrackedFiles(absolutePath, nextRelativePath)))
      continue
    }

    if (entry.isFile()) {
      files.push(normalizeRelativePath(nextRelativePath))
    }
  }

  return files.sort((left, right) => left.localeCompare(right))
}

async function snapshotProjectHashes(rootPath: string): Promise<Map<string, string>> {
  const files = await listTrackedFiles(rootPath)
  const hashes = await Promise.all(
    files.map(async (relativePath) => [
      relativePath,
      await hashFile(resolveWorkspaceTarget(rootPath, relativePath))
    ] as const)
  )

  return new Map(hashes)
}

async function snapshotWorkspaceFiles(
  workspacePath: string,
  previousCache?: Map<string, FileFingerprint>
): Promise<Map<string, FileFingerprint>> {
  const files = await listTrackedFiles(workspacePath)
  const snapshots = await Promise.all(
    files.map(async (relativePath) => {
      const absolutePath = resolveWorkspaceTarget(workspacePath, relativePath)
      const stats = await fs.stat(absolutePath)
      const signature = createSignature(stats.size, stats.mtimeMs)
      const previous = previousCache?.get(relativePath)
      const hash = previous?.signature === signature ? previous.hash : await hashFile(absolutePath)

      return [relativePath, { signature, hash }] as const
    })
  )

  return new Map(snapshots)
}

async function writeSandboxGitExclude(workspacePath: string): Promise<void> {
  const excludeFilePath = path.join(workspacePath, '.git', 'info', 'exclude')
  const ignoreEntries = new Set<string>([
    ...IGNORED_DIRECTORIES,
    ...SANDBOX_LINK_DIRECTORIES
  ])

  const content = [...ignoreEntries]
    .filter(Boolean)
    .map((entry) => `${entry.replace(/\\/g, '/')}/`)
    .join('\n')

  await fs.mkdir(path.dirname(excludeFilePath), { recursive: true })
  await fs.writeFile(excludeFilePath, content ? `${content}\n` : '', 'utf-8')
}

async function initializeSandboxRepository(workspacePath: string): Promise<void> {
  try {
    await runCommand('git', ['init', '-b', 'sentinel-sandbox'], workspacePath)
  } catch {
    await runCommand('git', ['init'], workspacePath)
    await runCommand('git', ['checkout', '-B', 'sentinel-sandbox'], workspacePath)
  }

  await writeSandboxGitExclude(workspacePath)
  await runCommand('git', ['config', 'user.name', 'Sentinel'], workspacePath)
  await runCommand('git', ['config', 'user.email', 'sentinel@local.invalid'], workspacePath)
  await runCommand('git', ['add', '-A'], workspacePath)

  try {
    await runCommand('git', ['commit', '-m', 'Sentinel sandbox baseline'], workspacePath)
  } catch {
    await runCommand('git', ['commit', '--allow-empty', '-m', 'Sentinel sandbox baseline'], workspacePath)
  }
}

async function ensureSharedDirectories(projectRoot: string, workspacePath: string): Promise<string[]> {
  const linkedDirectories: string[] = []

  for (const directoryName of SANDBOX_LINK_DIRECTORIES) {
    const sourcePath = path.join(projectRoot, directoryName)
    const destinationPath = path.join(workspacePath, directoryName)

    if (!(await pathExists(sourcePath))) {
      continue
    }

    try {
      await fs.rm(destinationPath, { recursive: true, force: true })
    } catch {
      // Ignore cleanup failures while replacing stale shared directories.
    }

    await fs.symlink(sourcePath, destinationPath, 'junction')
    linkedDirectories.push(directoryName)
  }

  return linkedDirectories
}

function collectModifiedPaths(
  baselineHashes: Map<string, string>,
  workspaceSnapshot: Map<string, FileFingerprint>
): string[] {
  const allPaths = new Set([...baselineHashes.keys(), ...workspaceSnapshot.keys()])

  return [...allPaths]
    .filter((relativePath) => baselineHashes.get(relativePath) !== workspaceSnapshot.get(relativePath)?.hash)
    .sort((left, right) => left.localeCompare(right))
}

export async function createSandboxWorkspace(
  projectRoot: string,
  workspacePath: string
): Promise<SandboxWorkspaceState> {
  const baselineHashes = await snapshotProjectHashes(projectRoot)
  await fs.rm(workspacePath, { recursive: true, force: true })
  await fs.mkdir(workspacePath, { recursive: true })
  await copyProjectTree(projectRoot, workspacePath)
  try {
    await initializeSandboxRepository(workspacePath)
  } catch {
    // Continue without sandbox git metadata when Git is unavailable.
  }
  const sharedDirectories = await ensureSharedDirectories(projectRoot, workspacePath)
  const scanCache = await snapshotWorkspaceFiles(workspacePath)

  return {
    baselineHashes,
    scanCache,
    sharedDirectories
  }
}

export async function refreshSandboxWorkspaceDiffs(
  workspacePath: string,
  sandboxState: SandboxWorkspaceState
): Promise<{ modifiedPaths: string[]; nextCache: Map<string, FileFingerprint> }> {
  const nextCache = await snapshotWorkspaceFiles(workspacePath, sandboxState.scanCache)

  return {
    modifiedPaths: collectModifiedPaths(sandboxState.baselineHashes, nextCache),
    nextCache
  }
}

export async function applySandboxWorkspace(
  sessionId: string,
  projectRoot: string,
  workspacePath: string,
  sandboxState: SandboxWorkspaceState
): Promise<{
  result: SessionApplyResult
  nextBaselineHashes: Map<string, string>
  nextCache: Map<string, FileFingerprint>
}> {
  const workspaceSnapshot = await snapshotWorkspaceFiles(workspacePath, sandboxState.scanCache)
  const modifiedPaths = collectModifiedPaths(sandboxState.baselineHashes, workspaceSnapshot)
  const conflicts: SessionSyncConflict[] = []
  const appliedPaths: string[] = []
  const nextBaselineHashes = new Map(sandboxState.baselineHashes)

  for (const relativePath of modifiedPaths) {
    const projectFilePath = resolveWorkspaceTarget(projectRoot, relativePath)
    const workspaceFilePath = resolveWorkspaceTarget(workspacePath, relativePath)
    const baselineHash = sandboxState.baselineHashes.get(relativePath) ?? null
    const workspaceHash = workspaceSnapshot.get(relativePath)?.hash ?? null
    const currentProjectHash = (await pathExists(projectFilePath)) ? await hashFile(projectFilePath) : null

    if (currentProjectHash !== baselineHash) {
      conflicts.push({
        path: relativePath,
        reason: 'project-changed',
        detail: 'The file changed in the main project after this sandbox session started.'
      })
      continue
    }

    try {
      if (workspaceHash === null) {
        await fs.rm(projectFilePath, { force: true })
        nextBaselineHashes.delete(relativePath)
      } else {
        await fs.mkdir(path.dirname(projectFilePath), { recursive: true })
        await fs.copyFile(workspaceFilePath, projectFilePath)
        nextBaselineHashes.set(relativePath, workspaceHash)
      }

      appliedPaths.push(relativePath)
    } catch (error) {
      conflicts.push({
        path: relativePath,
        reason: 'project-path-blocked',
        detail: error instanceof Error ? error.message : 'Sentinel could not write this file back to the project.'
      })
    }
  }

  const refreshedCache = await snapshotWorkspaceFiles(workspacePath, workspaceSnapshot)

  return {
    result: {
      sessionId,
      workspaceStrategy: 'sandbox-copy',
      appliedPaths,
      conflicts
    },
    nextBaselineHashes,
    nextCache: refreshedCache
  }
}

export async function discardSandboxWorkspace(
  projectRoot: string,
  workspacePath: string
): Promise<SandboxWorkspaceState> {
  return createSandboxWorkspace(projectRoot, workspacePath)
}

export async function writeSandboxFile(
  workspacePath: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = resolveWorkspaceTarget(workspacePath, relativePath)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, content, 'utf-8')
}
