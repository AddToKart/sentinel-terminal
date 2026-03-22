import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'

import { dialog } from 'electron'
import * as nodePty from 'node-pty'
import type { IPty } from 'node-pty'

import type {
  ActivityLogEntry,
  BootstrapPayload,
  CreateSessionInput,
  ProjectState,
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
import {
  arrayEquals,
  createEmptyProject,
  createHistoryEntry,
  createTimestamp,
  createToken,
  delay,
  emptyMetrics,
  round
} from './helpers'
import { IdeService } from './IdeService'
import { ProcessService } from './ProcessService'
import type { ManagerEvents, SessionRecord } from './types'
import { WorkspaceService } from './WorkspaceService'

function parseWindowsBuildNumber(): number | undefined {
  if (process.platform !== 'win32') {
    return undefined
  }

  const releaseParts = os.release().split('.')
  const buildPart = releaseParts[releaseParts.length - 1]
  const parsed = Number.parseInt(buildPart ?? '', 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export class SessionManager extends EventEmitter {
  private readonly _sessionRecords = new Map<string, SessionRecord>()
  private readonly _metricsTimer: NodeJS.Timeout
  private readonly _activityLog: ActivityLogEntry[] = []
  private readonly _windowsBuildNumber = parseWindowsBuildNumber()
  private readonly _processService: ProcessService
  private readonly _workspaceService: WorkspaceService
  private readonly _ideService: IdeService

  private _refreshInFlight = false
  private _projectState: ProjectState = createEmptyProject()
  private _preferences: WorkspacePreferences = {
    defaultSessionStrategy: 'sandbox-copy'
  }
  private _workspaceSummary: WorkspaceSummary = {
    activeSessions: 0,
    totalCpuPercent: 0,
    totalMemoryMb: 0,
    totalProcesses: 0,
    lastUpdated: Date.now(),
    defaultSessionStrategy: 'sandbox-copy'
  }

  constructor() {
    super()

    this._processService = new ProcessService()
    this._workspaceService = new WorkspaceService((entry) => {
      this._pushActivityLog(entry)
    })
    this._ideService = new IdeService({
      processService: this._processService,
      workspaceService: this._workspaceService,
      emitState: (state) => {
        this.emit('ide-terminal-state', state)
      },
      emitOutput: (payload) => {
        this.emit('ide-terminal-output', payload)
      }
    })

    this._metricsTimer = setInterval(() => {
      this._scheduleRuntimeRefresh()
    }, METRIC_INTERVAL_MS)
  }

  override on<K extends keyof ManagerEvents>(eventName: K, listener: (...args: ManagerEvents[K]) => void): this {
    return super.on(eventName, listener)
  }

  override emit<K extends keyof ManagerEvents>(eventName: K, ...args: ManagerEvents[K]): boolean {
    return super.emit(eventName, ...args)
  }

  async bootstrap(): Promise<BootstrapPayload> {
    return {
      project: structuredClone(this._projectState),
      sessions: this._listSessions(),
      summary: structuredClone(this._workspaceSummary),
      activityLog: structuredClone(this._activityLog),
      metrics: this._listSessionMetrics(),
      histories: this._listSessionHistories(),
      diffs: this._listSessionDiffs(),
      preferences: structuredClone(this._preferences),
      ideTerminal: this._ideService.getState(),
      windowsBuildNumber: this._windowsBuildNumber
    }
  }

  async setDefaultSessionStrategy(strategy: SessionWorkspaceStrategy): Promise<WorkspacePreferences> {
    this._preferences = {
      defaultSessionStrategy: strategy
    }
    this._emitWorkspaceState()
    return structuredClone(this._preferences)
  }

  async selectProject(): Promise<ProjectState> {
    const result = await dialog.showOpenDialog({
      title: 'Open a repository',
      defaultPath: this._projectState.path,
      properties: ['openDirectory']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return structuredClone(this._projectState)
    }

    return this.loadProject(result.filePaths[0])
  }

  async refreshProject(): Promise<ProjectState> {
    if (!this._projectState.path) {
      return structuredClone(this._projectState)
    }

    return this.loadProject(this._projectState.path)
  }

  async loadProject(candidatePath: string): Promise<ProjectState> {
    const nextProjectState = await this._workspaceService.inspectProject(candidatePath)
    await this._ideService.handleProjectChanged(nextProjectState.path)
    this._projectState = nextProjectState
    this._emitWorkspaceState()
    return structuredClone(this._projectState)
  }

  async createSession(input: CreateSessionInput = {}): Promise<SessionSummary> {
    const projectPath = this._projectState.path
    if (!projectPath) {
      throw new Error('Open a project folder before starting an agent session.')
    }

    const workspaceStrategy = input.workspaceStrategy ?? this._preferences.defaultSessionStrategy
    if (workspaceStrategy === 'git-worktree' && !this._projectState.isGitRepo) {
      throw new Error('Git Worktree mode requires a Git repository. Use Sandbox Copy mode for plain folders.')
    }

    const label = input.label?.trim() || `Agent ${String(this._sessionRecords.size + 1).padStart(2, '0')}`
    const sessionId = `${createTimestamp()}-${createToken()}`
    const workspace = await this._workspaceService.createSessionWorkspace(
      this._projectState,
      label,
      workspaceStrategy
    )

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
      await this._workspaceService.cleanupDetachedSessionWorkspace(projectPath, workspace)
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

    this._sessionRecords.set(sessionId, record)
    this._processService.registerSessionRootPid(sessionId, terminal.pid)
    this.emit('session-state', structuredClone(summary))
    this._emitSessionMetrics(record, Date.now())
    this._emitSessionHistory(record)
    this._emitSessionDiff(record)
    this._emitWorkspaceState()

    terminal.onData((data) => {
      if (record.summary.status === 'starting') {
        record.summary.status = 'ready'
        this.emit('session-state', structuredClone(record.summary))
        this._emitWorkspaceState()
      }

      this.emit('session-output', { sessionId, data })
    })

    terminal.onExit(({ exitCode }) => {
      void this._finalizeSession(record, exitCode)
    })

    if (input.startupCommand?.trim()) {
      this._appendHistoryEntry(record, input.startupCommand.trim(), 'startup')
      terminal.write(`${input.startupCommand}\r`)
    }

    this._scheduleRuntimeRefresh()

    return structuredClone(summary)
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    const record = this._sessionRecords.get(sessionId)
    if (!record) {
      return
    }

    this._trackCommandInput(record, data)
    record.terminal.write(data)
  }

  async ensureIdeTerminal() {
    return this._ideService.ensureTerminal(this._projectState)
  }

  async sendIdeTerminalInput(data: string): Promise<void> {
    await this._ideService.sendInput(this._projectState, data)
  }

  async resizeIdeTerminal(cols: number, rows: number): Promise<void> {
    await this._ideService.resizeTerminal(this._projectState, cols, rows)
  }

  async writeIdeFile(relativePath: string, content: string): Promise<void> {
    await this._ideService.writeFile(this._projectState, relativePath, content)
  }

  async applyIdeWorkspace() {
    const result = await this._ideService.applyWorkspace(this._projectState)
    await this.refreshProject()
    return result
  }

  async discardIdeWorkspaceChanges(): Promise<void> {
    await this._ideService.discardWorkspaceChanges(this._projectState)
  }

  async readFile(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf-8')
    } catch {
      return ''
    }
  }

  async writeSessionFile(sessionId: string, relativePath: string, content: string): Promise<void> {
    const record = this._sessionRecords.get(sessionId)
    if (!record) {
      throw new Error('Session not found.')
    }

    await this._workspaceService.writeSessionFile(record, relativePath, content)
    this._scheduleRuntimeRefresh()
  }

  async readFileDiff(sessionId: string, filePath: string): Promise<string> {
    const record = this._sessionRecords.get(sessionId)
    if (!record) {
      return ''
    }

    return this._workspaceService.readFileDiff(record, filePath)
  }

  async applySession(sessionId: string) {
    const record = this._sessionRecords.get(sessionId)
    if (!record || !this._projectState.path) {
      throw new Error('Session or project not found.')
    }

    const result = await this._workspaceService.applySession(record)

    if (record.summary.workspaceStrategy === 'git-worktree') {
      await this.refreshProject()
      this._scheduleRuntimeRefresh()
      return result
    }

    this._emitSessionDiff(record)
    await this.refreshProject()
    return result
  }

  async commitSession(sessionId: string, message: string): Promise<void> {
    const record = this._sessionRecords.get(sessionId)
    if (!record || !this._projectState.path) {
      throw new Error('Session or project not found.')
    }

    await this._workspaceService.commitSession(record, message)
    this._scheduleRuntimeRefresh()
  }

  async discardSessionChanges(sessionId: string): Promise<void> {
    const record = this._sessionRecords.get(sessionId)
    if (!record || !this._projectState.path) {
      throw new Error('Session or project not found.')
    }

    await this._workspaceService.discardSessionChanges(record)
    if (record.summary.workspaceStrategy === 'sandbox-copy') {
      this._emitSessionDiff(record)
    }
    this._scheduleRuntimeRefresh()
  }

  async resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
    const record = this._sessionRecords.get(sessionId)
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
    const record = this._sessionRecords.get(sessionId)
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
        this._emitSessionDiff(record)
        this.emit('session-state', structuredClone(record.summary))
        this._emitWorkspaceState()
      }

      await this._processService.terminateSessionProcesses(record)

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
      await this._finalizeSession(record, record.summary.exitCode ?? null, {
        error: 'Sentinel forced this session to close after the shell stopped responding.'
      })
    }

    this._removeSession(sessionId)
  }

  dispose(): void {
    clearInterval(this._metricsTimer)
    this._processService.dispose(this._sessionRecords.values(), this._ideService.getRecord())
  }

  private _scheduleRuntimeRefresh(): void {
    if (this._refreshInFlight) {
      return
    }

    this._refreshInFlight = true

    void this._refreshRuntimeState()
      .catch(() => undefined)
      .finally(() => {
        this._refreshInFlight = false
      })
  }

  private _listSessions(): SessionSummary[] {
    return [...this._sessionRecords.values()]
      .map((record) => structuredClone(record.summary))
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  private _listSessionMetrics(): SessionMetricsUpdate[] {
    return [...this._sessionRecords.values()]
      .map((record) =>
        structuredClone({
          sessionId: record.summary.id,
          pid: record.summary.pid,
          processIds: this._processService.getTrackedPids(record.summary.id),
          metrics: record.summary.metrics,
          sampledAt: this._workspaceSummary.lastUpdated
        })
      )
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  private _listSessionHistories(): SessionHistoryUpdate[] {
    return [...this._sessionRecords.values()]
      .map((record) =>
        structuredClone({
          sessionId: record.summary.id,
          entries: record.history
        })
      )
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  private _listSessionDiffs(): SessionDiffUpdate[] {
    return [...this._sessionRecords.values()]
      .map((record) =>
        structuredClone({
          sessionId: record.summary.id,
          modifiedPaths: record.modifiedPaths,
          updatedAt: record.summary.createdAt
        })
      )
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  private _emitSessionMetrics(record: SessionRecord, sampledAt: number): void {
    this.emit('session-metrics', {
      sessionId: record.summary.id,
      pid: record.summary.pid,
      processIds: this._processService.getTrackedPids(record.summary.id),
      metrics: structuredClone(record.summary.metrics),
      sampledAt
    })
  }

  private _emitSessionHistory(record: SessionRecord): void {
    this.emit('session-history', {
      sessionId: record.summary.id,
      entries: structuredClone(record.history)
    })
  }

  private _emitSessionDiff(record: SessionRecord): void {
    this.emit('session-diff', {
      sessionId: record.summary.id,
      modifiedPaths: structuredClone(record.modifiedPaths),
      updatedAt: Date.now()
    })
  }

  private _appendHistoryEntry(
    record: SessionRecord,
    command: string,
    source: SessionCommandEntry['source']
  ): void {
    const normalizedCommand = command.trim()
    if (!normalizedCommand) {
      return
    }

    record.history = [createHistoryEntry(normalizedCommand, source), ...record.history].slice(0, 250)
    this._emitSessionHistory(record)
  }

  private _trackCommandInput(record: SessionRecord, data: string): void {
    for (const character of data) {
      if (character === '\r' || character === '\n') {
        this._appendHistoryEntry(record, record.commandBuffer, 'interactive')
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

  private _pushActivityLog(entry: Omit<ActivityLogEntry, 'id' | 'timestamp'>): void {
    const logEntry: ActivityLogEntry = {
      id: `${createTimestamp()}-${createToken()}`,
      timestamp: Date.now(),
      ...entry
    }

    this._activityLog.unshift(logEntry)
    if (this._activityLog.length > 120) {
      this._activityLog.length = 120
    }

    this.emit('activity-log', structuredClone(logEntry))
  }

  private async _finalizeSession(
    record: SessionRecord,
    exitCode: number | null,
    options?: { error?: string }
  ): Promise<void> {
    if (record.finalizePromise) {
      await record.finalizePromise
      return
    }

    record.finalizePromise = (async () => {
      await this._processService.terminateSessionProcesses(record)
      this._processService.clearTrackedPids(record.summary.id)

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
      this._emitSessionMetrics(record, Date.now())
      this._emitSessionDiff(record)
      await this._workspaceService.cleanupSessionWorkspace(record.summary)
      record.finalized = true
      this.emit('session-state', structuredClone(record.summary))
      this._emitWorkspaceState()
      record.resolveClosed()
    })()

    await record.finalizePromise
  }

  private _removeSession(sessionId: string): void {
    this._sessionRecords.delete(sessionId)
    this._processService.removeSession(sessionId)
    this._emitWorkspaceState()
  }

  private async _refreshRuntimeState(): Promise<void> {
    const activeRecords = [...this._sessionRecords.values()].filter(
      (record) =>
        record.summary.status === 'starting' ||
        record.summary.status === 'ready' ||
        record.summary.status === 'closing'
    )

    if (activeRecords.length === 0) {
      await this._ideService.refreshWorkspaceDiffs()
      this._emitWorkspaceState()
      return
    }

    const sampledAt = await this._processService.refreshSessionMetrics(activeRecords)
    const diffMap = await this._workspaceService.collectWorkspaceDiffs(
      activeRecords.filter(
        (record) => record.summary.status === 'starting' || record.summary.status === 'ready'
      )
    )

    for (const record of activeRecords) {
      this._emitSessionMetrics(record, sampledAt)

      const nextModifiedPaths = diffMap.get(record.summary.id) ?? []
      if (!arrayEquals(record.modifiedPaths, nextModifiedPaths)) {
        record.modifiedPaths = nextModifiedPaths
        this._emitSessionDiff(record)
      }
    }

    await this._ideService.refreshWorkspaceDiffs()
    this._emitWorkspaceState()
  }

  private _emitWorkspaceState(): void {
    const activeSessions = [...this._sessionRecords.values()].filter(
      (record) =>
        record.summary.status === 'starting' ||
        record.summary.status === 'ready' ||
        record.summary.status === 'closing'
    )

    this._workspaceSummary = {
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
      defaultSessionStrategy: this._preferences.defaultSessionStrategy,
      projectPath: this._projectState.path,
      projectName: this._projectState.name,
      branch: this._projectState.branch
    }

    this.emit('workspace-state', structuredClone(this._workspaceSummary))
  }
}
