import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dialog } from 'electron'
import * as nodePty from 'node-pty'
import type { IPty } from 'node-pty'

import type {
  ActivityLogEntry,
  BootstrapPayload,
  CreateSessionInput,
  IdeTerminalState,
  ProjectState,
  SessionApplyResult,
  SessionCommandEntry,
  SessionDiffUpdate,
  SessionHistoryUpdate,
  SessionMetricsUpdate,
  SessionSummary,
  SessionWorkspaceStrategy,
  WorkspacePreferences,
  WorkspaceSummary
} from '@shared/types'

import { CLOSE_TIMEOUT_MS, METRIC_INTERVAL_MS } from './constants'
import { pathExists, runCommand, runPowerShell } from './commands'
import {
  arrayEquals,
  createEmptyProject,
  createHistoryEntry,
  createTimestamp,
  createToken,
  delay,
  emptyMetrics,
  normalizeRelativePath,
  round,
  sanitizeSegment
} from './helpers'
import { buildProjectTree } from './project-tree'
import {
  applySandboxWorkspace,
  createSandboxWorkspace,
  discardSandboxWorkspace,
  refreshSandboxWorkspaceDiffs,
  writeSandboxFile
} from './sandbox-workspace'
import {
  clearProcessUsageCache,
  collectPidUsage,
  collectProcessTreeSnapshots,
  collectWorkspaceDiffs
} from './runtime-monitor'
import type { IdeTerminalRecord, ManagerEvents, ProcessTreeSnapshot, SessionRecord } from './types'

function resolveWorkspaceFilePath(workspacePath: string, relativePath: string): string {
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

export class SessionManager extends EventEmitter {
  private readonly sessionRecords = new Map<string, SessionRecord>()
  private readonly pidRegistry = new Map<string, Set<number>>()
  private readonly metricsTimer: NodeJS.Timeout
  private readonly activityLog: ActivityLogEntry[] = []
  private ideTerminalRecord: IdeTerminalRecord | null = null
  private ideTerminalState: IdeTerminalState = {
    status: 'idle',
    shell: 'powershell.exe',
    modifiedPaths: []
  }
  private ideWorkspacePath?: string
  private ideWorkspaceProjectRoot?: string
  private ideSandboxState?: SessionRecord['sandboxState']
  private refreshInFlight = false
  private projectState: ProjectState = createEmptyProject()
  private preferences: WorkspacePreferences = {
    defaultSessionStrategy: 'sandbox-copy'
  }
  private workspaceSummary: WorkspaceSummary = {
    activeSessions: 0,
    totalCpuPercent: 0,
    totalMemoryMb: 0,
    totalProcesses: 0,
    lastUpdated: Date.now(),
    defaultSessionStrategy: 'sandbox-copy'
  }

  constructor() {
    super()
    this.metricsTimer = setInterval(() => {
      this.scheduleRuntimeRefresh()
    }, METRIC_INTERVAL_MS)
  }

  override on<K extends keyof ManagerEvents>(eventName: K, listener: (...args: ManagerEvents[K]) => void): this {
    return super.on(eventName, listener)
  }

  override emit<K extends keyof ManagerEvents>(eventName: K, ...args: ManagerEvents[K]): boolean {
    return super.emit(eventName, ...args)
  }

  private scheduleRuntimeRefresh(): void {
    if (this.refreshInFlight) {
      return
    }

    this.refreshInFlight = true

    void this.refreshRuntimeState()
      .catch(() => undefined)
      .finally(() => {
        this.refreshInFlight = false
      })
  }

  async bootstrap(): Promise<BootstrapPayload> {
    return {
      project: structuredClone(this.projectState),
      sessions: this.listSessions(),
      summary: structuredClone(this.workspaceSummary),
      activityLog: structuredClone(this.activityLog),
      metrics: this.listSessionMetrics(),
      histories: this.listSessionHistories(),
      diffs: this.listSessionDiffs(),
      preferences: structuredClone(this.preferences),
      ideTerminal: structuredClone(this.ideTerminalState)
    }
  }

  async setDefaultSessionStrategy(strategy: SessionWorkspaceStrategy): Promise<WorkspacePreferences> {
    this.preferences = {
      defaultSessionStrategy: strategy
    }
    this.emitWorkspaceState()
    return structuredClone(this.preferences)
  }

  async selectProject(): Promise<ProjectState> {
    const result = await dialog.showOpenDialog({
      title: 'Open a repository',
      defaultPath: this.projectState.path,
      properties: ['openDirectory']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return structuredClone(this.projectState)
    }

    return this.loadProject(result.filePaths[0])
  }

  async refreshProject(): Promise<ProjectState> {
    if (!this.projectState.path) {
      return structuredClone(this.projectState)
    }

    return this.loadProject(this.projectState.path)
  }

  async loadProject(candidatePath: string): Promise<ProjectState> {
    const requestedPath = path.resolve(candidatePath)
    let projectRoot = requestedPath
    let branch: string | undefined
    let isGitRepo = false

    try {
      projectRoot = await this.runGitCommand(requestedPath, ['rev-parse', '--show-toplevel'])
      branch = await this.runGitCommand(projectRoot, ['branch', '--show-current'])
      isGitRepo = true
    } catch {
      branch = undefined
      isGitRepo = false
    }

    const nextProjectState: ProjectState = {
      path: projectRoot,
      name: path.basename(projectRoot),
      branch: branch || undefined,
      isGitRepo,
      tree: await buildProjectTree(projectRoot)
    }

    const ideTerminalNeedsRestart =
      this.ideTerminalRecord &&
      path.resolve(this.ideTerminalRecord.state.cwd || '') !== nextProjectState.path

    if (ideTerminalNeedsRestart) {
      await this.closeIdeTerminal()
    }

    if (
      this.ideWorkspaceProjectRoot &&
      path.resolve(this.ideWorkspaceProjectRoot) !== path.resolve(projectRoot)
    ) {
      await this.cleanupIdeWorkspace()
    }

    this.projectState = nextProjectState

    this.emitWorkspaceState()
    return structuredClone(this.projectState)
  }

  async createSession(input: CreateSessionInput = {}): Promise<SessionSummary> {
    const projectPath = this.projectState.path
    if (!projectPath) {
      throw new Error('Open a project folder before starting an agent session.')
    }

    const workspaceStrategy = input.workspaceStrategy ?? this.preferences.defaultSessionStrategy
    if (workspaceStrategy === 'git-worktree' && !this.projectState.isGitRepo) {
      throw new Error('Git Worktree mode requires a Git repository. Use Sandbox Copy mode for plain folders.')
    }

    const label = input.label?.trim() || `Agent ${String(this.sessionRecords.size + 1).padStart(2, '0')}`
    const sessionId = `${createTimestamp()}-${createToken()}`
    const workspace = await this.createSessionWorkspace(label, workspaceStrategy)

    let resolveClosed: () => void = () => undefined
    const closePromise = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })

    let terminal: IPty

    try {
      terminal = nodePty.spawn('powershell.exe', ['-NoLogo'], {
        cols: input.cols ?? 120,
        rows: input.rows ?? 32,
        cwd: workspace.workspacePath,
        name: 'xterm-256color',
        useConpty: true,
        env: {
          ...process.env,
          FORCE_COLOR: '1',
          SENTINEL_SESSION_ID: sessionId,
          SENTINEL_WORKSPACE_PATH: workspace.workspacePath,
          SENTINEL_WORKSPACE_MODE: workspaceStrategy,
          SENTINEL_BRANCH: workspace.branchName || ''
        }
      })
    } catch (error) {
      await this.cleanupDetachedSessionWorkspace(projectPath, workspace)
      throw error
    }

    const summary: SessionSummary = {
      id: sessionId,
      label,
      projectRoot: projectPath,
      cwd: workspace.workspacePath,
      workspacePath: workspace.workspacePath,
      workspaceStrategy,
      branchName: workspace.branchName,
      status: 'starting',
      cleanupState: 'active',
      shell: 'powershell.exe',
      pid: terminal.pid,
      createdAt: Date.now(),
      startupCommand: input.startupCommand,
      metrics: emptyMetrics()
    }

    const record: SessionRecord = {
      summary,
      terminal,
      terminalSize: {
        cols: input.cols ?? 120,
        rows: input.rows ?? 32
      },
      closePromise,
      resolveClosed,
      closeRequested: false,
      finalized: false,
      commandBuffer: '',
      history: [],
      modifiedPaths: [],
      sandboxState: workspace.sandboxState
    }

    this.sessionRecords.set(sessionId, record)
    this.pidRegistry.set(
      sessionId,
      new Set(typeof terminal.pid === 'number' ? [terminal.pid] : [])
    )
    this.emit('session-state', structuredClone(summary))
    this.emitSessionMetrics(record, this.getTrackedPids(sessionId), Date.now())
    this.emitSessionHistory(record)
    this.emitSessionDiff(record)
    this.emitWorkspaceState()

    terminal.onData((data) => {
      if (record.summary.status === 'starting') {
        record.summary.status = 'ready'
        this.emit('session-state', structuredClone(record.summary))
        this.emitWorkspaceState()
      }

      this.emit('session-output', { sessionId, data })
    })

    terminal.onExit(({ exitCode }) => {
      void this.finalizeSession(record, exitCode)
    })

    if (input.startupCommand?.trim()) {
      this.appendHistoryEntry(record, input.startupCommand.trim(), 'startup')
      terminal.write(`${input.startupCommand}\r`)
    }

    this.scheduleRuntimeRefresh()

    return structuredClone(summary)
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    const record = this.sessionRecords.get(sessionId)
    if (!record) {
      return
    }

    this.trackCommandInput(record, data)
    record.terminal.write(data)
  }

  async ensureIdeTerminal(): Promise<IdeTerminalState> {
    const projectPath = this.projectState.path
    if (!projectPath) {
      this.ideTerminalState = this.createIdleIdeTerminalState()
      this.emitIdeTerminalState()
      return structuredClone(this.ideTerminalState)
    }

    const workspace = await this.ensureIdeWorkspace()

    const activeRecord = this.ideTerminalRecord
    if (
      activeRecord &&
      path.resolve(activeRecord.state.cwd || '') === path.resolve(workspace.workspacePath) &&
      activeRecord.state.status !== 'closed' &&
      activeRecord.state.status !== 'error'
    ) {
      return structuredClone(activeRecord.state)
    }

    if (activeRecord) {
      await this.closeIdeTerminal()
    }

    return this.spawnIdeTerminal(workspace.workspacePath, workspace.modifiedPaths)
  }

  async sendIdeTerminalInput(data: string): Promise<void> {
    const record = this.ideTerminalRecord
    if (!record) {
      await this.ensureIdeTerminal()
    }

    this.ideTerminalRecord?.terminal.write(data)
  }

  async resizeIdeTerminal(cols: number, rows: number): Promise<void> {
    if (cols <= 0 || rows <= 0) {
      return
    }

    if (!this.ideTerminalRecord) {
      await this.ensureIdeTerminal()
    }

    if (!this.ideTerminalRecord) {
      return
    }

    if (this.ideTerminalRecord.terminalSize.cols === cols && this.ideTerminalRecord.terminalSize.rows === rows) {
      return
    }

    this.ideTerminalRecord.terminalSize = { cols, rows }
    this.ideTerminalRecord.terminal.resize(cols, rows)
  }

  async writeIdeFile(relativePath: string, content: string): Promise<void> {
    const workspace = await this.ensureIdeWorkspace()
    await writeSandboxFile(workspace.workspacePath, relativePath, content)
    await this.refreshIdeWorkspaceDiffs()
  }

  async applyIdeWorkspace(): Promise<SessionApplyResult> {
    const workspace = await this.ensureIdeWorkspace()
    const projectPath = this.projectState.path
    if (!projectPath || !workspace.sandboxState) {
      throw new Error('IDE workspace is unavailable.')
    }

    this.pushActivityLog({
      scope: 'workspace',
      status: 'started',
      command: 'Apply IDE workspace changes to project',
      cwd: workspace.workspacePath
    })

    try {
      const applied = await applySandboxWorkspace(
        'ide-workspace',
        projectPath,
        workspace.workspacePath,
        workspace.sandboxState
      )

      this.ideSandboxState = {
        ...workspace.sandboxState,
        baselineHashes: applied.nextBaselineHashes,
        scanCache: applied.nextCache
      }

      await this.refreshIdeWorkspaceDiffs()
      await this.refreshProject()

      this.pushActivityLog({
        scope: 'workspace',
        status: applied.result.conflicts.length > 0 ? 'failed' : 'completed',
        command: 'Apply IDE workspace changes to project',
        cwd: workspace.workspacePath,
        detail:
          applied.result.conflicts.length > 0
            ? `${applied.result.appliedPaths.length} applied, ${applied.result.conflicts.length} conflicts`
            : `${applied.result.appliedPaths.length} file(s) applied`
      })

      return applied.result
    } catch (error) {
      this.pushActivityLog({
        scope: 'workspace',
        status: 'failed',
        command: 'Apply IDE workspace changes to project',
        cwd: workspace.workspacePath,
        detail: error instanceof Error ? error.message : 'IDE workspace apply failed.'
      })
      throw error
    }
  }

  async discardIdeWorkspaceChanges(): Promise<void> {
    const workspace = await this.ensureIdeWorkspace()
    const projectPath = this.projectState.path
    if (!projectPath) {
      throw new Error('Project is unavailable.')
    }

    this.pushActivityLog({
      scope: 'workspace',
      status: 'started',
      command: 'Discard IDE workspace changes',
      cwd: workspace.workspacePath
    })

    try {
      this.ideSandboxState = await discardSandboxWorkspace(projectPath, workspace.workspacePath)
      await this.refreshIdeWorkspaceDiffs()
      this.pushActivityLog({
        scope: 'workspace',
        status: 'completed',
        command: 'Discard IDE workspace changes',
        cwd: workspace.workspacePath
      })
    } catch (error) {
      this.pushActivityLog({
        scope: 'workspace',
        status: 'failed',
        command: 'Discard IDE workspace changes',
        cwd: workspace.workspacePath,
        detail: error instanceof Error ? error.message : 'IDE workspace discard failed.'
      })
      throw error
    }
  }

  async readFile(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf-8')
    } catch {
      return ''
    }
  }

  async writeSessionFile(sessionId: string, relativePath: string, content: string): Promise<void> {
    const record = this.sessionRecords.get(sessionId)
    if (!record) {
      throw new Error('Session not found.')
    }

    if (record.summary.workspaceStrategy === 'sandbox-copy') {
      await writeSandboxFile(record.summary.workspacePath, relativePath, content)
    } else {
      const filePath = resolveWorkspaceFilePath(record.summary.workspacePath, relativePath)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content, 'utf-8')
    }

    this.scheduleRuntimeRefresh()
  }

  async readFileDiff(sessionId: string, filePath: string): Promise<string> {
    const record = this.sessionRecords.get(sessionId)
    if (!record) {
      return ''
    }

    if (record.summary.workspaceStrategy !== 'git-worktree') {
      return ''
    }

    try {
      return await this.runGitCommand(record.summary.workspacePath, ['diff', 'HEAD', '--', filePath])
    } catch {
      return ''
    }
  }

  async applySession(sessionId: string): Promise<SessionApplyResult> {
    const record = this.sessionRecords.get(sessionId)
    if (!record || !this.projectState.path) {
      throw new Error('Session or project not found.')
    }

    if (record.summary.workspaceStrategy === 'git-worktree') {
      await this.runGitCommand(this.projectState.path, ['merge', record.summary.branchName || ''])
      await this.refreshProject()
      this.scheduleRuntimeRefresh()

      return {
        sessionId,
        workspaceStrategy: 'git-worktree',
        appliedPaths: [...record.modifiedPaths],
        conflicts: []
      }
    }

    if (!record.sandboxState) {
      throw new Error('Sandbox session state is unavailable.')
    }

    this.pushActivityLog({
      scope: 'workspace',
      status: 'started',
      command: 'Apply sandbox changes to project',
      cwd: record.summary.workspacePath
    })

    try {
      const applied = await applySandboxWorkspace(
        sessionId,
        record.summary.projectRoot,
        record.summary.workspacePath,
        record.sandboxState
      )
      record.sandboxState.baselineHashes = applied.nextBaselineHashes
      record.sandboxState.scanCache = applied.nextCache

      const refreshedDiffs = await refreshSandboxWorkspaceDiffs(
        record.summary.workspacePath,
        record.sandboxState
      )
      record.sandboxState.scanCache = refreshedDiffs.nextCache
      record.modifiedPaths = refreshedDiffs.modifiedPaths
      this.emitSessionDiff(record)

      await this.refreshProject()
      this.pushActivityLog({
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
      this.pushActivityLog({
        scope: 'workspace',
        status: 'failed',
        command: 'Apply sandbox changes to project',
        cwd: record.summary.workspacePath,
        detail: error instanceof Error ? error.message : 'Sandbox apply failed.'
      })
      throw error
    }
  }

  async commitSession(sessionId: string, message: string): Promise<void> {
    const record = this.sessionRecords.get(sessionId)
    if (!record || !this.projectState.path) {
      throw new Error('Session or project not found.')
    }

    if (record.summary.workspaceStrategy !== 'git-worktree') {
      throw new Error('Commit is only available for Git Worktree sessions.')
    }

    await this.runGitCommand(record.summary.workspacePath, ['add', '.'])
    await this.runGitCommand(record.summary.workspacePath, ['commit', '-m', message])
    this.scheduleRuntimeRefresh()
  }

  async discardSessionChanges(sessionId: string): Promise<void> {
    const record = this.sessionRecords.get(sessionId)
    if (!record || !this.projectState.path) {
      throw new Error('Session or project not found.')
    }

    if (record.summary.workspaceStrategy === 'git-worktree') {
      await this.runGitCommand(record.summary.workspacePath, ['reset', '--hard'])
      await this.runGitCommand(record.summary.workspacePath, ['clean', '-fd'])
      this.scheduleRuntimeRefresh()
      return
    }

    this.pushActivityLog({
      scope: 'workspace',
      status: 'started',
      command: 'Discard sandbox changes',
      cwd: record.summary.workspacePath
    })

    try {
      record.sandboxState = await discardSandboxWorkspace(record.summary.projectRoot, record.summary.workspacePath)
      record.modifiedPaths = []
      this.emitSessionDiff(record)
      this.pushActivityLog({
        scope: 'workspace',
        status: 'completed',
        command: 'Discard sandbox changes',
        cwd: record.summary.workspacePath
      })
      this.scheduleRuntimeRefresh()
    } catch (error) {
      this.pushActivityLog({
        scope: 'workspace',
        status: 'failed',
        command: 'Discard sandbox changes',
        cwd: record.summary.workspacePath,
        detail: error instanceof Error ? error.message : 'Sandbox discard failed.'
      })
      throw error
    }
  }

  async resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
    const record = this.sessionRecords.get(sessionId)
    if (!record || cols <= 0 || rows <= 0) {
      return
    }

    if (record.terminalSize.cols === cols && record.terminalSize.rows === rows) {
      return
    }

    record.terminalSize = { cols, rows }
    record.terminal.resize(cols, rows)
  }

  async closeSession(sessionId: string): Promise<void> {
    const record = this.sessionRecords.get(sessionId)
    if (!record) {
      return
    }

    if (!record.closeRequested) {
      record.closeRequested = true

      if (
        record.summary.status === 'starting' ||
        record.summary.status === 'ready' ||
        record.summary.status === 'error'
      ) {
        record.summary.status = 'closing'
        record.summary.error = undefined
        record.modifiedPaths = []
        this.emitSessionDiff(record)
        this.emit('session-state', structuredClone(record.summary))
        this.emitWorkspaceState()
      }

      await this.terminateSessionProcesses(record)

      try {
        record.terminal.kill()
      } catch {
        // The PTY may already be shutting down.
      }
    }

    const closedInTime = await Promise.race([
      record.closePromise.then(() => true),
      delay(CLOSE_TIMEOUT_MS).then(() => false)
    ])

    if (!closedInTime) {
      await this.finalizeSession(record, record.summary.exitCode ?? null, {
        error: 'Sentinel forced this session to close after the shell stopped responding.'
      })
    }

    this.removeSession(sessionId)
  }

  private async closeIdeTerminal(): Promise<void> {
    const record = this.ideTerminalRecord
    if (!record) {
      return
    }

    if (!record.closeRequested) {
      record.closeRequested = true

      if (
        record.state.status === 'starting' ||
        record.state.status === 'ready' ||
        record.state.status === 'error'
      ) {
        record.state.status = 'closing'
        record.state.error = undefined
        this.ideTerminalState = { ...record.state }
        this.emitIdeTerminalState()
      }

      await this.terminateProcessId(record.state.pid)

      try {
        record.terminal.kill()
      } catch {
        // The PTY may already be shutting down.
      }
    }

    const closedInTime = await Promise.race([
      record.closePromise.then(() => true),
      delay(CLOSE_TIMEOUT_MS).then(() => false)
    ])

    if (!closedInTime) {
      await this.finalizeIdeTerminal(record, record.state.exitCode ?? null, {
        error: 'Sentinel forced the IDE terminal to close after the shell stopped responding.'
      })
    }
  }

  dispose(): void {
    clearInterval(this.metricsTimer)
    clearProcessUsageCache()

    for (const record of this.sessionRecords.values()) {
      record.closeRequested = true
      void this.terminateSessionProcesses(record)

      try {
        record.terminal.kill()
      } catch {
        // Ignore teardown errors while the app is closing.
      }
    }

    if (this.ideTerminalRecord) {
      this.ideTerminalRecord.closeRequested = true
      void this.terminateProcessId(this.ideTerminalRecord.state.pid)

      try {
        this.ideTerminalRecord.terminal.kill()
      } catch {
        // Ignore teardown errors while the app is closing.
      }
    }
  }

  private listSessions(): SessionSummary[] {
    return [...this.sessionRecords.values()]
      .map((record) => structuredClone(record.summary))
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  private listSessionMetrics(): SessionMetricsUpdate[] {
    return [...this.sessionRecords.values()]
      .map((record) =>
        structuredClone({
          sessionId: record.summary.id,
          pid: record.summary.pid,
          processIds: this.getTrackedPids(record.summary.id),
          metrics: record.summary.metrics,
          sampledAt: this.workspaceSummary.lastUpdated
        })
      )
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  private listSessionHistories(): SessionHistoryUpdate[] {
    return [...this.sessionRecords.values()]
      .map((record) =>
        structuredClone({
          sessionId: record.summary.id,
          entries: record.history
        })
      )
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  private listSessionDiffs(): SessionDiffUpdate[] {
    return [...this.sessionRecords.values()]
      .map((record) =>
        structuredClone({
          sessionId: record.summary.id,
          modifiedPaths: record.modifiedPaths,
          updatedAt: record.summary.createdAt
        })
      )
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  private emitSessionMetrics(record: SessionRecord, processIds: number[], sampledAt: number): void {
    this.emit('session-metrics', {
      sessionId: record.summary.id,
      pid: record.summary.pid,
      processIds,
      metrics: structuredClone(record.summary.metrics),
      sampledAt
    })
  }

  private emitSessionHistory(record: SessionRecord): void {
    this.emit('session-history', {
      sessionId: record.summary.id,
      entries: structuredClone(record.history)
    })
  }

  private emitSessionDiff(record: SessionRecord): void {
    this.emit('session-diff', {
      sessionId: record.summary.id,
      modifiedPaths: structuredClone(record.modifiedPaths),
      updatedAt: Date.now()
    })
  }

  private appendHistoryEntry(
    record: SessionRecord,
    command: string,
    source: SessionCommandEntry['source']
  ): void {
    const normalizedCommand = command.trim()
    if (!normalizedCommand) {
      return
    }

    record.history = [createHistoryEntry(normalizedCommand, source), ...record.history].slice(0, 250)
    this.emitSessionHistory(record)
  }

  private trackCommandInput(record: SessionRecord, data: string): void {
    for (const character of data) {
      if (character === '\r' || character === '\n') {
        this.appendHistoryEntry(record, record.commandBuffer, 'interactive')
        record.commandBuffer = ''
        continue
      }

      if (character === '\u0003' || character === '\u0015') {
        record.commandBuffer = ''
        continue
      }

      if (character === '\u0008' || character === '\u007f') {
        record.commandBuffer = record.commandBuffer.slice(0, -1)
        continue
      }

      if (character >= ' ' || character === '\t') {
        record.commandBuffer += character
      }
    }
  }

  private pushActivityLog(entry: Omit<ActivityLogEntry, 'id' | 'timestamp'>): void {
    const logEntry: ActivityLogEntry = {
      id: `${createTimestamp()}-${createToken()}`,
      timestamp: Date.now(),
      ...entry
    }

    this.activityLog.unshift(logEntry)
    if (this.activityLog.length > 120) {
      this.activityLog.length = 120
    }

    this.emit('activity-log', structuredClone(logEntry))
  }

  private async runGitCommand(cwd: string, args: string[]): Promise<string> {
    const command = ['git', '-C', cwd, ...args].join(' ')
    this.pushActivityLog({
      scope: 'git',
      status: 'started',
      command,
      cwd
    })

    try {
      const stdout = await runCommand('git', ['-C', cwd, ...args], cwd)
      this.pushActivityLog({
        scope: 'git',
        status: 'completed',
        command,
        cwd
      })
      return stdout
    } catch (error) {
      this.pushActivityLog({
        scope: 'git',
        status: 'failed',
        command,
        cwd,
        detail: error instanceof Error ? error.message : 'Git command failed.'
      })
      throw error
    }
  }

  private async createSessionWorkspace(
    label: string,
    workspaceStrategy: SessionWorkspaceStrategy
  ): Promise<{ workspacePath: string; branchName?: string; sandboxState?: SessionRecord['sandboxState'] }> {
    if (workspaceStrategy === 'git-worktree') {
      const worktree = await this.createWorktree(label)
      return {
        workspacePath: worktree.workspacePath,
        branchName: worktree.branchName
      }
    }

    const projectPath = this.projectState.path
    if (!projectPath) {
      throw new Error('Project root is unavailable.')
    }

    const projectName = sanitizeSegment(this.projectState.name || 'project')
    const sessionStamp = createTimestamp()
    const token = createToken()
    const tempRoot = path.join(os.tmpdir(), 'sentinel-sandboxes', projectName)
    const workspacePath = path.join(tempRoot, `${sanitizeSegment(label)}-${sessionStamp}-${token}`)

    await fs.mkdir(tempRoot, { recursive: true })
    this.pushActivityLog({
      scope: 'workspace',
      status: 'started',
      command: 'Create sandbox workspace',
      cwd: workspacePath
    })

    try {
      const sandboxState = await createSandboxWorkspace(projectPath, workspacePath)
      this.pushActivityLog({
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
      this.pushActivityLog({
        scope: 'workspace',
        status: 'failed',
        command: 'Create sandbox workspace',
        cwd: workspacePath,
        detail: error instanceof Error ? error.message : 'Sandbox creation failed.'
      })
      throw error
    }
  }

  private async createWorktree(
    label: string
  ): Promise<{ branchName: string; workspacePath: string }> {
    const projectPath = this.projectState.path

    if (!projectPath) {
      throw new Error('Project root is unavailable.')
    }

    const projectName = sanitizeSegment(this.projectState.name || 'repo')
    const sessionStamp = createTimestamp()
    const token = createToken()
    const branchName = `sentinel/${projectName}-${sanitizeSegment(label)}-${sessionStamp}-${token}`
    const tempRoot = path.join(os.tmpdir(), 'sentinel-worktrees', projectName)
    const workspacePath = path.join(tempRoot, `${sanitizeSegment(label)}-${sessionStamp}-${token}`)

    await fs.mkdir(tempRoot, { recursive: true })
    await this.runGitCommand(projectPath, ['worktree', 'add', '-b', branchName, workspacePath, 'HEAD'])

    return {
      branchName,
      workspacePath
    }
  }

  private async finalizeSession(
    record: SessionRecord,
    exitCode: number | null,
    options?: { error?: string }
  ): Promise<void> {
    if (record.finalizePromise) {
      await record.finalizePromise
      return
    }

    record.finalizePromise = (async () => {
      await this.terminateSessionProcesses(record)
      this.clearTrackedPids(record.summary.id)

      const closedCleanly = exitCode === 0 || exitCode === null
      record.summary.exitCode = exitCode
      record.summary.status = record.closeRequested || closedCleanly ? 'closed' : 'error'
      record.summary.metrics = emptyMetrics()

      if (options?.error) {
        record.summary.error = options.error
      } else if (!record.closeRequested && !closedCleanly) {
        record.summary.error = `PowerShell exited unexpectedly with code ${exitCode}.`
      } else {
        record.summary.error = undefined
      }

      record.commandBuffer = ''
      record.modifiedPaths = []
      this.emitSessionMetrics(record, [], Date.now())
      this.emitSessionDiff(record)
      await this.cleanupSessionWorkspace(record.summary)
      record.finalized = true
      this.emit('session-state', structuredClone(record.summary))
      this.emitWorkspaceState()
      record.resolveClosed()
    })()

    await record.finalizePromise
  }

  private async cleanupSessionWorkspace(summary: SessionSummary): Promise<void> {
    if (summary.workspaceStrategy === 'git-worktree') {
      await this.cleanupWorktree(summary)
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

  private async cleanupWorktree(summary: SessionSummary): Promise<void> {
    const projectPath = summary.projectRoot
    if (!projectPath || !(await pathExists(summary.workspacePath))) {
      summary.cleanupState = 'removed'
      return
    }

    const cleanupErrors: string[] = []

    try {
      await this.runGitCommand(projectPath, ['worktree', 'remove', '--force', summary.workspacePath])
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : 'Worktree remove failed.')
    }

    if (summary.branchName) {
      try {
        await this.runGitCommand(projectPath, ['branch', '-D', summary.branchName])
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

  private async cleanupDetachedSessionWorkspace(
    projectPath: string,
    workspace: { workspacePath: string; branchName?: string }
  ): Promise<void> {
    if (workspace.branchName) {
      await this.cleanupDetachedWorktree(projectPath, workspace.branchName, workspace.workspacePath)
      return
    }

    try {
      await fs.rm(workspace.workspacePath, { recursive: true, force: true })
    } catch {
      // Ignore best-effort cleanup failures while unwinding a failed session create.
    }
  }

  private async cleanupDetachedWorktree(
    projectPath: string | undefined,
    branchName: string,
    workspacePath: string
  ): Promise<void> {
    if (!projectPath) {
      return
    }

    try {
      await this.runGitCommand(projectPath, ['worktree', 'remove', '--force', workspacePath])
    } catch {
      // The worktree may not have been registered yet.
    }

    try {
      await this.runGitCommand(projectPath, ['branch', '-D', branchName])
    } catch {
      // Ignore cleanup errors while unwinding a failed create.
    }

    try {
      await fs.rm(workspacePath, { recursive: true, force: true })
    } catch {
      // Ignore best-effort filesystem cleanup failures.
    }
  }

  private removeSession(sessionId: string): void {
    this.sessionRecords.delete(sessionId)
    this.pidRegistry.delete(sessionId)
    this.emitWorkspaceState()
  }

  private createIdleIdeTerminalState(): IdeTerminalState {
    return {
      status: 'idle',
      shell: 'powershell.exe',
      cwd: this.ideWorkspacePath ?? this.projectState.path,
      workspacePath: this.ideWorkspacePath,
      modifiedPaths: this.ideTerminalState.modifiedPaths
    }
  }

  private emitIdeTerminalState(): void {
    this.emit('ide-terminal-state', structuredClone(this.ideTerminalState))
  }

  private async ensureIdeWorkspace(): Promise<{
    workspacePath: string
    sandboxState: NonNullable<SessionRecord['sandboxState']>
    modifiedPaths: string[]
  }> {
    const projectRoot = this.projectState.path
    if (!projectRoot) {
      throw new Error('Open a project folder before using IDE mode.')
    }

    if (
      this.ideWorkspacePath &&
      this.ideWorkspaceProjectRoot &&
      this.ideSandboxState &&
      path.resolve(this.ideWorkspaceProjectRoot) === path.resolve(projectRoot)
    ) {
      return {
        workspacePath: this.ideWorkspacePath,
        sandboxState: this.ideSandboxState,
        modifiedPaths: this.ideTerminalState.modifiedPaths
      }
    }

    if (this.ideWorkspacePath) {
      await this.cleanupIdeWorkspace()
    }

    const projectName = sanitizeSegment(this.projectState.name || 'project')
    const sessionStamp = createTimestamp()
    const token = createToken()
    const tempRoot = path.join(os.tmpdir(), 'sentinel-ide', projectName)
    const workspacePath = path.join(tempRoot, `ide-${sessionStamp}-${token}`)

    await fs.mkdir(tempRoot, { recursive: true })
    this.pushActivityLog({
      scope: 'workspace',
      status: 'started',
      command: 'Create IDE workspace',
      cwd: workspacePath
    })

    try {
      const sandboxState = await createSandboxWorkspace(projectRoot, workspacePath)
      this.ideWorkspacePath = workspacePath
      this.ideWorkspaceProjectRoot = projectRoot
      this.ideSandboxState = sandboxState
      this.ideTerminalState = {
        ...this.ideTerminalState,
        cwd: workspacePath,
        workspacePath,
        modifiedPaths: []
      }
      this.emitIdeTerminalState()
      this.pushActivityLog({
        scope: 'workspace',
        status: 'completed',
        command: 'Create IDE workspace',
        cwd: workspacePath
      })

      return {
        workspacePath,
        sandboxState,
        modifiedPaths: []
      }
    } catch (error) {
      this.pushActivityLog({
        scope: 'workspace',
        status: 'failed',
        command: 'Create IDE workspace',
        cwd: workspacePath,
        detail: error instanceof Error ? error.message : 'IDE workspace creation failed.'
      })
      throw error
    }
  }

  private async refreshIdeWorkspaceDiffs(): Promise<void> {
    if (!(this.ideWorkspacePath && this.ideSandboxState)) {
      return
    }

    const refreshed = await refreshSandboxWorkspaceDiffs(this.ideWorkspacePath, this.ideSandboxState)
    this.ideSandboxState = {
      ...this.ideSandboxState,
      scanCache: refreshed.nextCache
    }

    if (!arrayEquals(this.ideTerminalState.modifiedPaths, refreshed.modifiedPaths)) {
      this.ideTerminalState = {
        ...this.ideTerminalState,
        cwd: this.ideWorkspacePath,
        workspacePath: this.ideWorkspacePath,
        modifiedPaths: refreshed.modifiedPaths
      }
      this.emitIdeTerminalState()
    }
  }

  private async cleanupIdeWorkspace(): Promise<void> {
    const workspacePath = this.ideWorkspacePath

    this.ideWorkspacePath = undefined
    this.ideWorkspaceProjectRoot = undefined
    this.ideSandboxState = undefined
    this.ideTerminalState = {
      ...this.ideTerminalState,
      cwd: this.projectState.path,
      workspacePath: undefined,
      modifiedPaths: []
    }
    this.emitIdeTerminalState()

    if (!(workspacePath && await pathExists(workspacePath))) {
      return
    }

    try {
      await fs.rm(workspacePath, { recursive: true, force: true })
    } catch {
      // Ignore best-effort cleanup failures while switching projects or shutting down.
    }
  }

  private async spawnIdeTerminal(workspacePath: string, modifiedPaths: string[]): Promise<IdeTerminalState> {
    let resolveClosed: () => void = () => undefined
    const closePromise = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })

    const terminal = nodePty.spawn('powershell.exe', ['-NoLogo'], {
      cols: 120,
      rows: 28,
      cwd: workspacePath,
      name: 'xterm-256color',
      useConpty: true,
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        SENTINEL_IDE_TERMINAL: '1',
        SENTINEL_PROJECT_ROOT: this.projectState.path || '',
        SENTINEL_WORKSPACE_PATH: workspacePath,
        SENTINEL_WORKSPACE_MODE: 'sandbox-copy'
      }
    })

    const record: IdeTerminalRecord = {
      state: {
        status: 'starting',
        shell: 'powershell.exe',
        cwd: workspacePath,
        workspacePath,
        pid: terminal.pid,
        createdAt: Date.now(),
        modifiedPaths
      },
      terminal,
      terminalSize: {
        cols: 120,
        rows: 28
      },
      closePromise,
      resolveClosed,
      closeRequested: false
    }

    this.ideTerminalRecord = record
    this.ideTerminalState = { ...record.state }
    this.emitIdeTerminalState()

    terminal.onData((data) => {
      if (record.state.status === 'starting') {
        record.state.status = 'ready'
        this.ideTerminalState = { ...record.state }
        this.emitIdeTerminalState()
      }

      this.emit('ide-terminal-output', { data })
    })

    terminal.onExit(({ exitCode }) => {
      void this.finalizeIdeTerminal(record, exitCode)
    })

    return structuredClone(record.state)
  }

  private async finalizeIdeTerminal(
    record: IdeTerminalRecord,
    exitCode: number | null,
    options?: { error?: string }
  ): Promise<void> {
    if (record.finalizePromise) {
      await record.finalizePromise
      return
    }

    record.finalizePromise = (async () => {
      await this.terminateProcessId(record.state.pid)

      const closedCleanly = exitCode === 0 || exitCode === null
      record.state.exitCode = exitCode
      record.state.status = record.closeRequested || closedCleanly ? 'closed' : 'error'

      if (options?.error) {
        record.state.error = options.error
      } else if (!record.closeRequested && !closedCleanly) {
        record.state.error = `PowerShell exited unexpectedly with code ${exitCode}.`
      } else {
        record.state.error = undefined
      }

      this.ideTerminalState = { ...record.state }
      if (this.ideTerminalRecord === record) {
        this.ideTerminalRecord = null
      }

      this.emitIdeTerminalState()
      record.resolveClosed()
    })()

    await record.finalizePromise
  }

  private async terminateProcessId(pid?: number): Promise<void> {
    if (!pid) {
      return
    }

    try {
      await runCommand('taskkill', ['/PID', String(pid), '/T', '/F'])
    } catch {
      // taskkill returns non-zero when the process has already exited.
    }
  }

  private async terminateSessionProcesses(record: SessionRecord): Promise<void> {
    const rootPid = record.summary.pid
    const otherPids = this.getTrackedPids(record.summary.id).filter((pid) => pid !== rootPid)

    if (!rootPid && otherPids.length === 0) {
      return
    }

    if (rootPid) {
      await this.terminateProcessId(rootPid)
    }

    if (otherPids.length === 0) {
      return
    }

    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      `$ids=@(${otherPids.join(',')})`,
      'Get-Process -Id $ids -ErrorAction SilentlyContinue | Sort-Object Id -Descending | Stop-Process -Force'
    ].join('; ')

    try {
      await runPowerShell(script)
    } catch {
      // Processes may have exited naturally by the time cleanup runs.
    }

    this.pidRegistry.set(record.summary.id, new Set())
  }

  private getTrackedPids(sessionId: string): number[] {
    const trackedPids = new Set(this.pidRegistry.get(sessionId) ?? [])

    return [...trackedPids]
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .sort((left, right) => right - left)
  }

  private updateTrackedPids(sessionId: string, processIds: number[]): void {
    this.pidRegistry.set(
      sessionId,
      new Set(processIds.filter((pid) => Number.isInteger(pid) && pid > 0))
    )
  }

  private clearTrackedPids(sessionId: string): void {
    this.pidRegistry.set(sessionId, new Set())
  }

  private async refreshRuntimeState(): Promise<void> {
    const activeRecords = [...this.sessionRecords.values()].filter(
      (record) =>
        record.summary.status === 'starting' ||
        record.summary.status === 'ready' ||
        record.summary.status === 'closing'
    )

    if (activeRecords.length === 0) {
      await this.refreshIdeWorkspaceDiffs()
      this.emitWorkspaceState()
      return
    }

    const rootIds = activeRecords
      .map((record) => record.summary.pid)
      .filter((pid): pid is number => typeof pid === 'number')

    const [snapshotMap, diffMap] = await Promise.all([
      rootIds.length > 0
        ? collectProcessTreeSnapshots(rootIds)
        : Promise.resolve(new Map<number, ProcessTreeSnapshot>()),
      collectWorkspaceDiffs(
        activeRecords.filter(
          (record) => record.summary.status === 'starting' || record.summary.status === 'ready'
        )
      )
    ])
    const usageMap =
      snapshotMap.size > 0
        ? await collectPidUsage([...snapshotMap.values()].flatMap((snapshot) => snapshot.processIds))
        : new Map<number, { cpu: number; memory: number }>()
    const sampledAt = Date.now()

    for (const record of activeRecords) {
      const pid = record.summary.pid
      const snapshot = typeof pid === 'number' ? snapshotMap.get(pid) : undefined
      const processIds = snapshot?.processIds ?? []
      this.updateTrackedPids(record.summary.id, processIds)

      record.summary.metrics = snapshot
        ? (() => {
            const aggregateUsage = snapshot.processIds.reduce(
              (totals, processId) => {
                const usage = usageMap.get(processId)
                if (!usage) {
                  return totals
                }

                return {
                  cpu: totals.cpu + usage.cpu,
                  memory: totals.memory + usage.memory
                }
              },
              { cpu: 0, memory: 0 }
            )

            return {
              cpuPercent: round(aggregateUsage.cpu, 1),
              memoryMb: round(aggregateUsage.memory / 1024 / 1024, 1),
              handleCount: snapshot.handleCount,
              threadCount: snapshot.threadCount,
              processCount: snapshot.processCount
            }
          })()
        : emptyMetrics()

      this.emitSessionMetrics(record, processIds, sampledAt)

      const nextModifiedPaths = diffMap.get(record.summary.id) ?? []
      if (!arrayEquals(record.modifiedPaths, nextModifiedPaths)) {
        record.modifiedPaths = nextModifiedPaths
        this.emitSessionDiff(record)
      }
    }

    await this.refreshIdeWorkspaceDiffs()
    this.emitWorkspaceState()
  }

  private emitWorkspaceState(): void {
    const activeSessions = [...this.sessionRecords.values()].filter(
      (record) =>
        record.summary.status === 'starting' ||
        record.summary.status === 'ready' ||
        record.summary.status === 'closing'
    )

    this.workspaceSummary = {
      activeSessions: activeSessions.length,
      totalCpuPercent: round(
        activeSessions.reduce((total, record) => total + record.summary.metrics.cpuPercent, 0),
        1
      ),
      totalMemoryMb: round(
        activeSessions.reduce((total, record) => total + record.summary.metrics.memoryMb, 0),
        1
      ),
      totalProcesses: activeSessions.reduce(
        (total, record) => total + record.summary.metrics.processCount,
        0
      ),
      lastUpdated: Date.now(),
      defaultSessionStrategy: this.preferences.defaultSessionStrategy,
      projectPath: this.projectState.path,
      projectName: this.projectState.name,
      branch: this.projectState.branch
    }

    this.emit('workspace-state', structuredClone(this.workspaceSummary))
  }
}
