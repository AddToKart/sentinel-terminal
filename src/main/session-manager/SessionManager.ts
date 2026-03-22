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
  ProjectState,
  SessionCommandEntry,
  SessionDiffUpdate,
  SessionHistoryUpdate,
  SessionMetricsUpdate,
  SessionSummary,
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
  round,
  sanitizeSegment
} from './helpers'
import { buildProjectTree } from './project-tree'
import {
  clearProcessUsageCache,
  collectPidUsage,
  collectProcessTreeSnapshots,
  collectWorktreeDiffs
} from './runtime-monitor'
import type { ManagerEvents, ProcessTreeSnapshot, SessionRecord } from './types'

export class SessionManager extends EventEmitter {
  private readonly sessionRecords = new Map<string, SessionRecord>()
  private readonly pidRegistry = new Map<string, Set<number>>()
  private readonly metricsTimer: NodeJS.Timeout
  private readonly activityLog: ActivityLogEntry[] = []
  private refreshInFlight = false
  private projectState: ProjectState = createEmptyProject()
  private workspaceSummary: WorkspaceSummary = {
    activeSessions: 0,
    totalCpuPercent: 0,
    totalMemoryMb: 0,
    totalProcesses: 0,
    lastUpdated: Date.now()
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
      diffs: this.listSessionDiffs()
    }
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

    this.projectState = {
      path: projectRoot,
      name: path.basename(projectRoot),
      branch: branch || undefined,
      isGitRepo,
      tree: await buildProjectTree(projectRoot)
    }

    this.emitWorkspaceState()
    return structuredClone(this.projectState)
  }

  async createSession(input: CreateSessionInput = {}): Promise<SessionSummary> {
    if (!this.projectState.path || !this.projectState.isGitRepo) {
      throw new Error('Open a Git repository before starting an agent session.')
    }

    const label = input.label?.trim() || `Agent ${String(this.sessionRecords.size + 1).padStart(2, '0')}`
    const { branchName, worktreePath } = await this.createWorktree(label)
    const sessionId = `${createTimestamp()}-${createToken()}`

    let resolveClosed: () => void = () => undefined
    const closePromise = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })

    let terminal: IPty

    try {
      terminal = nodePty.spawn('powershell.exe', ['-NoLogo'], {
        cols: input.cols ?? 120,
        rows: input.rows ?? 32,
        cwd: worktreePath,
        name: 'xterm-256color',
        useConpty: true,
        env: {
          ...process.env,
          FORCE_COLOR: '1',
          SENTINEL_SESSION_ID: sessionId,
          SENTINEL_WORKTREE: worktreePath,
          SENTINEL_BRANCH: branchName
        }
      })
    } catch (error) {
      await this.cleanupDetachedWorktree(this.projectState.path, branchName, worktreePath)
      throw error
    }

    const summary: SessionSummary = {
      id: sessionId,
      label,
      projectRoot: this.projectState.path,
      cwd: worktreePath,
      worktreePath,
      branchName,
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
      closePromise,
      resolveClosed,
      closeRequested: false,
      finalized: false,
      commandBuffer: '',
      history: [],
      modifiedPaths: []
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

  async resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
    const record = this.sessionRecords.get(sessionId)
    if (!record || cols <= 0 || rows <= 0) {
      return
    }

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

  private async createWorktree(label: string): Promise<{ branchName: string; worktreePath: string }> {
    const projectPath = this.projectState.path

    if (!projectPath) {
      throw new Error('Project root is unavailable.')
    }

    const projectName = sanitizeSegment(this.projectState.name || 'repo')
    const sessionStamp = createTimestamp()
    const token = createToken()
    const branchName = `sentinel/${projectName}-${sanitizeSegment(label)}-${sessionStamp}-${token}`
    const tempRoot = path.join(os.tmpdir(), 'sentinel-worktrees', projectName)
    const worktreePath = path.join(tempRoot, `${sanitizeSegment(label)}-${sessionStamp}-${token}`)

    await fs.mkdir(tempRoot, { recursive: true })
    await this.runGitCommand(projectPath, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'])

    return {
      branchName,
      worktreePath
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
      await this.cleanupWorktree(record.summary)
      record.finalized = true
      this.emit('session-state', structuredClone(record.summary))
      this.emitWorkspaceState()
      record.resolveClosed()
    })()

    await record.finalizePromise
  }

  private async cleanupWorktree(summary: SessionSummary): Promise<void> {
    const projectPath = summary.projectRoot
    if (!projectPath || !(await pathExists(summary.worktreePath))) {
      summary.cleanupState = 'removed'
      return
    }

    const cleanupErrors: string[] = []

    try {
      await this.runGitCommand(projectPath, ['worktree', 'remove', '--force', summary.worktreePath])
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : 'Worktree remove failed.')
    }

    try {
      await this.runGitCommand(projectPath, ['branch', '-D', summary.branchName])
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : 'Branch cleanup failed.')
    }

    try {
      await fs.rm(summary.worktreePath, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : 'Filesystem cleanup failed.')
    }

    if (cleanupErrors.length > 0 && (await pathExists(summary.worktreePath))) {
      summary.cleanupState = 'failed'
      summary.error = cleanupErrors.join(' ')
      return
    }

    summary.cleanupState = 'removed'
  }

  private async cleanupDetachedWorktree(
    projectPath: string | undefined,
    branchName: string,
    worktreePath: string
  ): Promise<void> {
    if (!projectPath) {
      return
    }

    try {
      await this.runGitCommand(projectPath, ['worktree', 'remove', '--force', worktreePath])
    } catch {
      // The worktree may not have been registered yet.
    }

    try {
      await this.runGitCommand(projectPath, ['branch', '-D', branchName])
    } catch {
      // Ignore cleanup errors while unwinding a failed create.
    }

    try {
      await fs.rm(worktreePath, { recursive: true, force: true })
    } catch {
      // Ignore best-effort filesystem cleanup failures.
    }
  }

  private removeSession(sessionId: string): void {
    this.sessionRecords.delete(sessionId)
    this.pidRegistry.delete(sessionId)
    this.emitWorkspaceState()
  }

  private async terminateSessionProcesses(record: SessionRecord): Promise<void> {
    const rootPid = record.summary.pid
    const otherPids = this.getTrackedPids(record.summary.id).filter((pid) => pid !== rootPid)

    if (!rootPid && otherPids.length === 0) {
      return
    }

    if (rootPid) {
      try {
        await runCommand('taskkill', ['/PID', String(rootPid), '/T', '/F'])
      } catch {
        // taskkill returns non-zero when the root process has already exited.
      }
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
      collectWorktreeDiffs(
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
      projectPath: this.projectState.path,
      projectName: this.projectState.name,
      branch: this.projectState.branch
    }

    this.emit('workspace-state', structuredClone(this.workspaceSummary))
  }
}
