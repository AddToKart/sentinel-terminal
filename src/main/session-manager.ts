import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dialog } from 'electron'
import * as nodePty from 'node-pty'
import type { IPty } from 'node-pty'
import pidusage from 'pidusage'

import type {
  ActivityLogEntry,
  BootstrapPayload,
  CreateSessionInput,
  ProcessMetrics,
  ProjectNode,
  ProjectState,
  SessionSummary,
  WorkspaceSummary
} from '@shared/types'

const TREE_DEPTH = 3
const TREE_ENTRY_LIMIT = 28
const METRIC_INTERVAL_MS = 2500
const RUN_COMMAND_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 4_000

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.venv',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '__pycache__'
])

interface ProcessTreeSnapshot {
  rootId: number
  cpuTotalSeconds: number
  workingSetBytes: number
  handleCount: number
  threadCount: number
  processCount: number
  processIds: number[]
}

interface RawProcessTreeSnapshot {
  RootId: number
  CpuTotalSeconds: number
  WorkingSetBytes: number
  HandleCount: number
  ThreadCount: number
  ProcessCount: number
  ProcessIds: number[]
}

interface SessionRecord {
  summary: SessionSummary
  terminal: IPty
  closePromise: Promise<void>
  resolveClosed: () => void
  lastCpuSeconds?: number
  lastCpuAt?: number
  closeRequested: boolean
  finalized: boolean
  finalizePromise?: Promise<void>
}

type ManagerEvents = {
  'session-output': [{ sessionId: string; data: string }]
  'session-state': [SessionSummary]
  'workspace-state': [WorkspaceSummary]
  'activity-log': [ActivityLogEntry]
}

function emptyMetrics(): ProcessMetrics {
  return {
    cpuPercent: 0,
    memoryMb: 0,
    threadCount: 0,
    handleCount: 0,
    processCount: 0
  }
}

function createEmptyProject(): ProjectState {
  return {
    isGitRepo: false,
    tree: []
  }
}

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function sanitizeSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'agent'
}

function createToken(): string {
  return Math.random().toString(36).slice(2, 8)
}

function createTimestamp(): string {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function runCommand(file: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        windowsHide: true,
        timeout: RUN_COMMAND_TIMEOUT_MS
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message))
          return
        }

        resolve(stdout.trim())
      }
    )
  })
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  return runCommand('git', ['-C', cwd, ...args], cwd)
}

async function runPowerShell(script: string): Promise<string> {
  return runCommand(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]
  )
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

async function buildProjectTree(rootPath: string, depth = TREE_DEPTH): Promise<ProjectNode[]> {
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

export class SessionManager extends EventEmitter {
  private readonly sessionRecords = new Map<string, SessionRecord>()
  private readonly pidRegistry = new Map<string, Set<number>>()
  private readonly cpuCount = Math.max(os.cpus().length, 1)
  private readonly metricsTimer: NodeJS.Timeout
  private readonly activityLog: ActivityLogEntry[] = []
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
      void this.refreshMetrics().catch(() => undefined)
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
      project: structuredClone(this.projectState),
      sessions: this.listSessions(),
      summary: structuredClone(this.workspaceSummary),
      activityLog: structuredClone(this.activityLog)
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
      finalized: false
    }

    this.sessionRecords.set(sessionId, record)
    this.pidRegistry.set(
      sessionId,
      new Set(typeof terminal.pid === 'number' ? [terminal.pid] : [])
    )
    this.emit('session-state', structuredClone(summary))
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
      terminal.write(`${input.startupCommand}\r`)
    }

    return structuredClone(summary)
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    const record = this.sessionRecords.get(sessionId)
    if (!record) {
      return
    }

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

      if (record.summary.status === 'starting' || record.summary.status === 'ready' || record.summary.status === 'error') {
        record.summary.status = 'closing'
        record.summary.error = undefined
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
      record.summary.status =
        record.closeRequested || closedCleanly ? 'closed' : 'error'
      record.summary.metrics = emptyMetrics()

      if (options?.error) {
        record.summary.error = options.error
      } else if (!record.closeRequested && !closedCleanly) {
        record.summary.error = `PowerShell exited unexpectedly with code ${exitCode}.`
      } else {
        record.summary.error = undefined
      }

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

  private async refreshMetrics(): Promise<void> {
    const activeRecords = [...this.sessionRecords.values()].filter(
      (record) => record.summary.status === 'starting' || record.summary.status === 'ready' || record.summary.status === 'closing'
    )

    if (activeRecords.length === 0) {
      this.emitWorkspaceState()
      return
    }

    const rootIds = activeRecords
      .map((record) => record.summary.pid)
      .filter((pid): pid is number => typeof pid === 'number')

    if (rootIds.length === 0) {
      this.emitWorkspaceState()
      return
    }

    const snapshotMap = await this.collectProcessTreeSnapshots(rootIds)
    const usageMap = await this.collectPidUsage(
      [...snapshotMap.values()].flatMap((snapshot) => snapshot.processIds)
    )

    for (const record of activeRecords) {
      const pid = record.summary.pid
      if (!pid) {
        continue
      }

      const snapshot = snapshotMap.get(pid)
      if (!snapshot) {
        this.updateTrackedPids(record.summary.id, [])
        continue
      }

      this.updateTrackedPids(record.summary.id, snapshot.processIds)
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

      record.summary.metrics = {
        cpuPercent: round(aggregateUsage.cpu, 1),
        memoryMb: round(aggregateUsage.memory / 1024 / 1024, 1),
        handleCount: snapshot.handleCount,
        threadCount: snapshot.threadCount,
        processCount: snapshot.processCount
      }

      this.emit('session-state', structuredClone(record.summary))
    }

    this.emitWorkspaceState()
  }

  private async collectPidUsage(
    processIds: number[]
  ): Promise<Map<number, { cpu: number; memory: number }>> {
    const uniquePids = [...new Set(processIds.filter((pid) => Number.isInteger(pid) && pid > 0))]
    if (uniquePids.length === 0) {
      return new Map()
    }

    try {
      const usage = await pidusage(uniquePids)
      const usageMap = new Map<number, { cpu: number; memory: number }>()

      for (const processId of uniquePids) {
        const stats = usage[String(processId)] ?? usage[processId]
        if (!stats) {
          continue
        }

        usageMap.set(processId, {
          cpu: typeof stats.cpu === 'number' ? stats.cpu : 0,
          memory: typeof stats.memory === 'number' ? stats.memory : 0
        })
      }

      return usageMap
    } catch {
      return new Map()
    }
  }

  private async collectProcessTreeSnapshots(rootIds: number[]): Promise<Map<number, ProcessTreeSnapshot>> {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      `$rootIds=@(${rootIds.join(',')})`,
      '$children=@{}',
      'Get-CimInstance Win32_Process | ForEach-Object {',
      "  $parent=[string]$_.ParentProcessId",
      '  if (-not $children.ContainsKey($parent)) { $children[$parent]=New-Object System.Collections.Generic.List[int] }',
      '  $children[$parent].Add([int]$_.ProcessId) | Out-Null',
      '}',
      '$result=@()',
      'foreach ($rootId in $rootIds) {',
      "  $queue=New-Object 'System.Collections.Generic.Queue[int]'",
      "  $seen=New-Object 'System.Collections.Generic.HashSet[int]'",
      '  $queue.Enqueue([int]$rootId)',
      '  while ($queue.Count -gt 0) {',
      '    $current=$queue.Dequeue()',
      '    if ($seen.Add($current)) {',
      '      $key=[string]$current',
      '      if ($children.ContainsKey($key)) {',
      '        foreach ($child in $children[$key]) { $queue.Enqueue([int]$child) }',
      '      }',
      '    }',
      '  }',
      '  $ids=@($seen)',
      '  $stats=@()',
      '  if ($ids.Count -gt 0) { $stats=Get-Process -Id $ids -ErrorAction SilentlyContinue }',
      '  $cpu=0.0',
      '  $workingSet=0',
      '  $handles=0',
      '  $threads=0',
      '  foreach ($proc in $stats) {',
      '    if ($null -ne $proc.CPU) { $cpu += [double]$proc.CPU }',
      '    if ($null -ne $proc.WorkingSet64) { $workingSet += [int64]$proc.WorkingSet64 }',
      '    if ($null -ne $proc.HandleCount) { $handles += [int]$proc.HandleCount }',
      '    if ($null -ne $proc.Threads) { $threads += $proc.Threads.Count }',
      '  }',
      '  $result += [pscustomobject]@{',
      '    RootId=[int]$rootId',
      '    CpuTotalSeconds=[double]$cpu',
      '    WorkingSetBytes=[int64]$workingSet',
      '    HandleCount=[int]$handles',
      '    ThreadCount=[int]$threads',
      '    ProcessCount=[int]$ids.Count',
      '    ProcessIds=@($ids)',
      '  }',
      '}',
      '$result | ConvertTo-Json -Compress'
    ].join('; ')

    let raw = ''

    try {
      raw = await runPowerShell(script)
    } catch {
      return new Map()
    }

    if (!raw) {
      return new Map()
    }

    const parsed = JSON.parse(raw) as RawProcessTreeSnapshot | RawProcessTreeSnapshot[]
    const snapshots = Array.isArray(parsed) ? parsed : [parsed]

    return new Map(
      snapshots.map((snapshot) => [
        snapshot.RootId,
        {
          rootId: snapshot.RootId,
          cpuTotalSeconds: snapshot.CpuTotalSeconds,
          workingSetBytes: snapshot.WorkingSetBytes,
          handleCount: snapshot.HandleCount,
          threadCount: snapshot.ThreadCount,
          processCount: snapshot.ProcessCount,
          processIds: Array.isArray(snapshot.ProcessIds) ? snapshot.ProcessIds : []
        }
      ])
    )
  }

  private emitWorkspaceState(): void {
    const activeSessions = [...this.sessionRecords.values()].filter(
      (record) => record.summary.status === 'starting' || record.summary.status === 'ready' || record.summary.status === 'closing'
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
      totalProcesses: activeSessions.reduce((total, record) => total + record.summary.metrics.processCount, 0),
      lastUpdated: Date.now(),
      projectPath: this.projectState.path,
      projectName: this.projectState.name,
      branch: this.projectState.branch
    }

    this.emit('workspace-state', structuredClone(this.workspaceSummary))
  }
}
