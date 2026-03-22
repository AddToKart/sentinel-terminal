import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {
  ActivityLogEntry,
  ProjectState,
  SessionApplyResult,
  SessionSummary,
  SessionWorkspaceStrategy
} from '@shared/types'

import { pathExists, runCommand } from './commands'
import { buildProjectTree } from './project-tree'
import {
  applySandboxWorkspace,
  createSandboxWorkspace,
  discardSandboxWorkspace,
  refreshSandboxWorkspaceDiffs as refreshSandboxDiffs,
  writeSandboxFile
} from './sandbox-workspace'
import { collectWorkspaceDiffs } from './runtime-monitor'
import { createTimestamp, createToken, normalizeRelativePath, sanitizeSegment } from './helpers'
import type { SandboxWorkspaceState, SessionRecord } from './types'

interface SessionWorkspaceResult {
  workspacePath: string
  branchName?: string
  sandboxState?: SessionRecord['sandboxState']
}

interface IdeWorkspaceResult {
  workspacePath: string
  sandboxState: NonNullable<SessionRecord['sandboxState']>
}

type ActivityLogger = (entry: Omit<ActivityLogEntry, 'id' | 'timestamp'>) => void

export class WorkspaceService {
  constructor(private readonly _logActivity: ActivityLogger) {}

  async inspectProject(candidatePath: string): Promise<ProjectState> {
    const requestedPath = path.resolve(candidatePath)
    let projectRoot = requestedPath
    let branch: string | undefined
    let isGitRepo = false

    try {
      projectRoot = await this._runGitCommand(requestedPath, ['rev-parse', '--show-toplevel'])
      branch = await this._runGitCommand(projectRoot, ['branch', '--show-current'])
      isGitRepo = true
    } catch {
      branch = undefined
      isGitRepo = false
    }

    return {
      path: projectRoot,
      name: path.basename(projectRoot),
      branch: branch || undefined,
      isGitRepo,
      tree: await buildProjectTree(projectRoot)
    }
  }

  async createSessionWorkspace(
    project: ProjectState,
    label: string,
    workspaceStrategy: SessionWorkspaceStrategy
  ): Promise<SessionWorkspaceResult> {
    if (workspaceStrategy === 'git-worktree') {
      return this._createWorktree(project, label)
    }

    const projectPath = project.path
    if (!projectPath) {
      throw new Error('Project root is unavailable.')
    }

    const projectName = sanitizeSegment(project.name || 'project')
    const sessionStamp = createTimestamp()
    const token = createToken()
    const tempRoot = path.join(os.tmpdir(), 'sentinel-sandboxes', projectName)
    const workspacePath = path.join(tempRoot, `${sanitizeSegment(label)}-${sessionStamp}-${token}`)

    await fs.mkdir(tempRoot, { recursive: true })
    this._logActivity({
      scope: 'workspace',
      status: 'started',
      command: 'Create sandbox workspace',
      cwd: workspacePath
    })

    try {
      const sandboxState = await createSandboxWorkspace(projectPath, workspacePath)
      this._logActivity({
        scope: 'workspace',
        status: 'completed',
        command: 'Create sandbox workspace',
        cwd: workspacePath
      })

      return {
        workspacePath,
        sandboxState
      }
    } catch (error) {
      this._logActivity({
        scope: 'workspace',
        status: 'failed',
        command: 'Create sandbox workspace',
        cwd: workspacePath,
        detail: error instanceof Error ? error.message : 'Sandbox creation failed.'
      })
      throw error
    }
  }

  async createIdeWorkspace(project: ProjectState): Promise<IdeWorkspaceResult> {
    const projectRoot = project.path
    if (!projectRoot) {
      throw new Error('Open a project folder before using IDE mode.')
    }

    const projectName = sanitizeSegment(project.name || 'project')
    const sessionStamp = createTimestamp()
    const token = createToken()
    const tempRoot = path.join(os.tmpdir(), 'sentinel-ide', projectName)
    const workspacePath = path.join(tempRoot, `ide-${sessionStamp}-${token}`)

    await fs.mkdir(tempRoot, { recursive: true })
    this._logActivity({
      scope: 'workspace',
      status: 'started',
      command: 'Create IDE workspace',
      cwd: workspacePath
    })

    try {
      const sandboxState = await createSandboxWorkspace(projectRoot, workspacePath)
      this._logActivity({
        scope: 'workspace',
        status: 'completed',
        command: 'Create IDE workspace',
        cwd: workspacePath
      })

      return {
        workspacePath,
        sandboxState
      }
    } catch (error) {
      this._logActivity({
        scope: 'workspace',
        status: 'failed',
        command: 'Create IDE workspace',
        cwd: workspacePath,
        detail: error instanceof Error ? error.message : 'IDE workspace creation failed.'
      })
      throw error
    }
  }

  async cleanupDetachedSessionWorkspace(
    projectRoot: string,
    workspace: { workspacePath: string; branchName?: string }
  ): Promise<void> {
    if (workspace.branchName) {
      await this._cleanupDetachedWorktree(projectRoot, workspace.branchName, workspace.workspacePath)
      return
    }

    try {
      await fs.rm(workspace.workspacePath, { recursive: true, force: true })
    } catch {
      // Ignore best-effort cleanup failures while unwinding a failed session create.
    }
  }

  async cleanupSessionWorkspace(summary: SessionSummary): Promise<void> {
    if (summary.workspaceStrategy === 'git-worktree') {
      await this._cleanupWorktree(summary)
      return
    }

    if (!(await pathExists(summary.workspacePath))) {
      summary.cleanupState = 'removed'
      return
    }

    try {
      await fs.rm(summary.workspacePath, { recursive: true, force: true })
      summary.cleanupState = 'removed'
    } catch (error) {
      summary.cleanupState = 'failed'
      summary.error = error instanceof Error ? error.message : 'Sandbox cleanup failed.'
    }
  }

  async cleanupIdeWorkspace(workspacePath?: string): Promise<void> {
    if (!(workspacePath && await pathExists(workspacePath))) {
      return
    }

    try {
      await fs.rm(workspacePath, { recursive: true, force: true })
    } catch {
      // Ignore best-effort cleanup failures while switching projects or shutting down.
    }
  }

  async writeSessionFile(record: SessionRecord, relativePath: string, content: string): Promise<void> {
    if (record.summary.workspaceStrategy === 'sandbox-copy') {
      await writeSandboxFile(record.summary.workspacePath, relativePath, content)
      return
    }

    const filePath = this._resolveWorkspaceFilePath(record.summary.workspacePath, relativePath)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
  }

  async writeWorkspaceFile(workspacePath: string, relativePath: string, content: string): Promise<void> {
    await writeSandboxFile(workspacePath, relativePath, content)
  }

  async readFileDiff(record: SessionRecord, filePath: string): Promise<string> {
    if (record.summary.workspaceStrategy !== 'git-worktree') {
      return ''
    }

    try {
      return await this._runGitCommand(record.summary.workspacePath, ['diff', 'HEAD', '--', filePath])
    } catch {
      return ''
    }
  }

  async applySession(record: SessionRecord): Promise<SessionApplyResult> {
    if (record.summary.workspaceStrategy === 'git-worktree') {
      await this._runGitCommand(record.summary.projectRoot, ['merge', record.summary.branchName || ''])

      return {
        sessionId: record.summary.id,
        workspaceStrategy: 'git-worktree',
        appliedPaths: [...record.modifiedPaths],
        conflicts: []
      }
    }

    if (!record.sandboxState) {
      throw new Error('Sandbox session state is unavailable.')
    }

    this._logActivity({
      scope: 'workspace',
      status: 'started',
      command: 'Apply sandbox changes to project',
      cwd: record.summary.workspacePath
    })

    try {
      const applied = await applySandboxWorkspace(
        record.summary.id,
        record.summary.projectRoot,
        record.summary.workspacePath,
        record.sandboxState
      )
      record.sandboxState.baselineHashes = applied.nextBaselineHashes
      record.sandboxState.scanCache = applied.nextCache

      const refreshedDiffs = await refreshSandboxDiffs(
        record.summary.workspacePath,
        record.sandboxState
      )
      record.sandboxState.scanCache = refreshedDiffs.nextCache
      record.modifiedPaths = refreshedDiffs.modifiedPaths

      this._logActivity({
        scope: 'workspace',
        status: applied.result.conflicts.length > 0 ? 'failed' : 'completed',
        command: 'Apply sandbox changes to project',
        cwd: record.summary.workspacePath,
        detail:
          applied.result.conflicts.length > 0
            ? `${applied.result.appliedPaths.length} applied, ${applied.result.conflicts.length} conflicts`
            : `${applied.result.appliedPaths.length} file(s) applied`
      })

      return applied.result
    } catch (error) {
      this._logActivity({
        scope: 'workspace',
        status: 'failed',
        command: 'Apply sandbox changes to project',
        cwd: record.summary.workspacePath,
        detail: error instanceof Error ? error.message : 'Sandbox apply failed.'
      })
      throw error
    }
  }

  async applyIdeWorkspace(
    projectRoot: string,
    workspacePath: string,
    sandboxState: NonNullable<SessionRecord['sandboxState']>
  ): Promise<{
    result: SessionApplyResult
    sandboxState: NonNullable<SessionRecord['sandboxState']>
    modifiedPaths: string[]
  }> {
    this._logActivity({
      scope: 'workspace',
      status: 'started',
      command: 'Apply IDE workspace changes to project',
      cwd: workspacePath
    })

    try {
      const applied = await applySandboxWorkspace(
        'ide-workspace',
        projectRoot,
        workspacePath,
        sandboxState
      )

      const nextSandboxState = {
        ...sandboxState,
        baselineHashes: applied.nextBaselineHashes,
        scanCache: applied.nextCache
      }
      const refreshed = await this.refreshIdeWorkspaceDiffs(workspacePath, nextSandboxState)

      this._logActivity({
        scope: 'workspace',
        status: applied.result.conflicts.length > 0 ? 'failed' : 'completed',
        command: 'Apply IDE workspace changes to project',
        cwd: workspacePath,
        detail:
          applied.result.conflicts.length > 0
            ? `${applied.result.appliedPaths.length} applied, ${applied.result.conflicts.length} conflicts`
            : `${applied.result.appliedPaths.length} file(s) applied`
      })

      return {
        result: applied.result,
        sandboxState: refreshed.sandboxState,
        modifiedPaths: refreshed.modifiedPaths
      }
    } catch (error) {
      this._logActivity({
        scope: 'workspace',
        status: 'failed',
        command: 'Apply IDE workspace changes to project',
        cwd: workspacePath,
        detail: error instanceof Error ? error.message : 'IDE workspace apply failed.'
      })
      throw error
    }
  }

  async commitSession(record: SessionRecord, message: string): Promise<void> {
    if (record.summary.workspaceStrategy !== 'git-worktree') {
      throw new Error('Commit is only available for Git Worktree sessions.')
    }

    await this._runGitCommand(record.summary.workspacePath, ['add', '.'])
    await this._runGitCommand(record.summary.workspacePath, ['commit', '-m', message])
  }

  async discardSessionChanges(record: SessionRecord): Promise<void> {
    if (record.summary.workspaceStrategy === 'git-worktree') {
      await this._runGitCommand(record.summary.workspacePath, ['reset', '--hard'])
      await this._runGitCommand(record.summary.workspacePath, ['clean', '-fd'])
      return
    }

    this._logActivity({
      scope: 'workspace',
      status: 'started',
      command: 'Discard sandbox changes',
      cwd: record.summary.workspacePath
    })

    try {
      record.sandboxState = await discardSandboxWorkspace(
        record.summary.projectRoot,
        record.summary.workspacePath
      )
      record.modifiedPaths = []
      this._logActivity({
        scope: 'workspace',
        status: 'completed',
        command: 'Discard sandbox changes',
        cwd: record.summary.workspacePath
      })
    } catch (error) {
      this._logActivity({
        scope: 'workspace',
        status: 'failed',
        command: 'Discard sandbox changes',
        cwd: record.summary.workspacePath,
        detail: error instanceof Error ? error.message : 'Sandbox discard failed.'
      })
      throw error
    }
  }

  async discardIdeWorkspaceChanges(
    projectRoot: string,
    workspacePath: string
  ): Promise<{
    sandboxState: NonNullable<SessionRecord['sandboxState']>
    modifiedPaths: string[]
  }> {
    this._logActivity({
      scope: 'workspace',
      status: 'started',
      command: 'Discard IDE workspace changes',
      cwd: workspacePath
    })

    try {
      const sandboxState = await discardSandboxWorkspace(projectRoot, workspacePath)
      this._logActivity({
        scope: 'workspace',
        status: 'completed',
        command: 'Discard IDE workspace changes',
        cwd: workspacePath
      })

      return {
        sandboxState,
        modifiedPaths: []
      }
    } catch (error) {
      this._logActivity({
        scope: 'workspace',
        status: 'failed',
        command: 'Discard IDE workspace changes',
        cwd: workspacePath,
        detail: error instanceof Error ? error.message : 'IDE workspace discard failed.'
      })
      throw error
    }
  }

  async refreshIdeWorkspaceDiffs(
    workspacePath: string,
    sandboxState: NonNullable<SessionRecord['sandboxState']>
  ): Promise<{
    sandboxState: NonNullable<SessionRecord['sandboxState']>
    modifiedPaths: string[]
  }> {
    const refreshed = await refreshSandboxDiffs(workspacePath, sandboxState)

    return {
      sandboxState: {
        ...sandboxState,
        scanCache: refreshed.nextCache
      },
      modifiedPaths: refreshed.modifiedPaths
    }
  }

  async collectWorkspaceDiffs(records: SessionRecord[]): Promise<Map<string, string[]>> {
    return collectWorkspaceDiffs(records)
  }

  private _resolveWorkspaceFilePath(workspacePath: string, relativePath: string): string {
    const normalizedRelativePath = normalizeRelativePath(relativePath)
    const resolvedPath = path.resolve(workspacePath, normalizedRelativePath)
    const normalizedWorkspacePath = path.resolve(workspacePath)
    const rootPrefix = normalizedWorkspacePath.endsWith(path.sep)
      ? normalizedWorkspacePath
      : `${normalizedWorkspacePath}${path.sep}`

    if (resolvedPath !== normalizedWorkspacePath && !resolvedPath.startsWith(rootPrefix)) {
      throw new Error(`Refusing to access a path outside the session workspace: ${relativePath}`)
    }

    return resolvedPath
  }

  private async _runGitCommand(cwd: string, args: string[]): Promise<string> {
    const command = ['git', '-C', cwd, ...args].join(' ')
    this._logActivity({
      scope: 'git',
      status: 'started',
      command,
      cwd
    })

    try {
      const stdout = await runCommand('git', ['-C', cwd, ...args], cwd)
      this._logActivity({
        scope: 'git',
        status: 'completed',
        command,
        cwd
      })
      return stdout
    } catch (error) {
      this._logActivity({
        scope: 'git',
        status: 'failed',
        command,
        cwd,
        detail: error instanceof Error ? error.message : 'Git command failed.'
      })
      throw error
    }
  }

  private async _createWorktree(
    project: ProjectState,
    label: string
  ): Promise<{ branchName: string; workspacePath: string }> {
    const projectPath = project.path

    if (!projectPath) {
      throw new Error('Project root is unavailable.')
    }

    const projectName = sanitizeSegment(project.name || 'repo')
    const sessionStamp = createTimestamp()
    const token = createToken()
    const branchName = `sentinel/${projectName}-${sanitizeSegment(label)}-${sessionStamp}-${token}`
    const tempRoot = path.join(os.tmpdir(), 'sentinel-worktrees', projectName)
    const workspacePath = path.join(tempRoot, `${sanitizeSegment(label)}-${sessionStamp}-${token}`)

    await fs.mkdir(tempRoot, { recursive: true })
    await this._runGitCommand(projectPath, ['worktree', 'add', '-b', branchName, workspacePath, 'HEAD'])

    return {
      branchName,
      workspacePath
    }
  }

  private async _cleanupWorktree(summary: SessionSummary): Promise<void> {
    const projectPath = summary.projectRoot
    if (!projectPath || !(await pathExists(summary.workspacePath))) {
      summary.cleanupState = 'removed'
      return
    }

    const cleanupErrors: string[] = []

    try {
      await this._runGitCommand(projectPath, ['worktree', 'remove', '--force', summary.workspacePath])
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : 'Worktree remove failed.')
    }

    if (summary.branchName) {
      try {
        await this._runGitCommand(projectPath, ['branch', '-D', summary.branchName])
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : 'Branch cleanup failed.')
      }
    }

    try {
      await fs.rm(summary.workspacePath, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : 'Filesystem cleanup failed.')
    }

    if (cleanupErrors.length > 0 && (await pathExists(summary.workspacePath))) {
      summary.cleanupState = 'failed'
      summary.error = cleanupErrors.join(' ')
      return
    }

    summary.cleanupState = 'removed'
  }

  private async _cleanupDetachedWorktree(
    projectPath: string | undefined,
    branchName: string,
    workspacePath: string
  ): Promise<void> {
    if (!projectPath) {
      return
    }

    try {
      await this._runGitCommand(projectPath, ['worktree', 'remove', '--force', workspacePath])
    } catch {
      // The worktree may not have been registered yet.
    }

    try {
      await this._runGitCommand(projectPath, ['branch', '-D', branchName])
    } catch {
      // Ignore cleanup errors while unwinding a failed create.
    }

    try {
      await fs.rm(workspacePath, { recursive: true, force: true })
    } catch {
      // Ignore best-effort filesystem cleanup failures.
    }
  }
}
