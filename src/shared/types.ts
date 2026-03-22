export type SessionStatus = 'starting' | 'ready' | 'closing' | 'closed' | 'error'

export type CleanupState = 'active' | 'removed' | 'preserved' | 'failed'

export type SessionWorkspaceStrategy = 'sandbox-copy' | 'git-worktree'

export interface ProcessMetrics {
  cpuPercent: number
  memoryMb: number
  threadCount: number
  handleCount: number
  processCount: number
}

export interface SessionMetricsUpdate {
  sessionId: string
  pid?: number
  processIds: number[]
  metrics: ProcessMetrics
  sampledAt: number
}

export interface ProjectNode {
  name: string
  path: string
  kind: 'file' | 'directory'
  children?: ProjectNode[]
}

export interface ProjectState {
  path?: string
  name?: string
  branch?: string
  isGitRepo: boolean
  tree: ProjectNode[]
}

export interface SessionSummary {
  id: string
  label: string
  projectRoot: string
  cwd: string
  workspacePath: string
  workspaceStrategy: SessionWorkspaceStrategy
  branchName?: string
  status: SessionStatus
  cleanupState: CleanupState
  shell: string
  pid?: number
  createdAt: number
  startupCommand?: string
  exitCode?: number | null
  error?: string
  metrics: ProcessMetrics
}

export interface WorkspaceSummary {
  activeSessions: number
  totalCpuPercent: number
  totalMemoryMb: number
  totalProcesses: number
  lastUpdated: number
  defaultSessionStrategy: SessionWorkspaceStrategy
  projectPath?: string
  projectName?: string
  branch?: string
}

export interface ActivityLogEntry {
  id: string
  timestamp: number
  scope: 'git' | 'workspace'
  status: 'started' | 'completed' | 'failed'
  command: string
  cwd: string
  detail?: string
}

export interface SessionCommandEntry {
  id: string
  command: string
  timestamp: number
  source: 'interactive' | 'startup'
}

export interface SessionHistoryUpdate {
  sessionId: string
  entries: SessionCommandEntry[]
}

export interface SessionDiffUpdate {
  sessionId: string
  modifiedPaths: string[]
  updatedAt: number
}

export interface SessionSyncConflict {
  path: string
  reason: 'project-changed' | 'project-path-blocked'
  detail?: string
}

export interface SessionApplyResult {
  sessionId: string
  workspaceStrategy: SessionWorkspaceStrategy
  appliedPaths: string[]
  conflicts: SessionSyncConflict[]
}

export interface WorkspacePreferences {
  defaultSessionStrategy: SessionWorkspaceStrategy
}

export interface IdeTerminalState {
  status: 'idle' | SessionStatus
  cwd?: string
  workspacePath?: string
  shell: string
  pid?: number
  createdAt?: number
  exitCode?: number | null
  error?: string
  modifiedPaths: string[]
}

export interface BootstrapPayload {
  project: ProjectState
  sessions: SessionSummary[]
  summary: WorkspaceSummary
  activityLog: ActivityLogEntry[]
  metrics: SessionMetricsUpdate[]
  histories: SessionHistoryUpdate[]
  diffs: SessionDiffUpdate[]
  preferences: WorkspacePreferences
  ideTerminal: IdeTerminalState
  windowsBuildNumber?: number
}

export interface CreateSessionInput {
  label?: string
  startupCommand?: string
  cols?: number
  rows?: number
  workspaceStrategy?: SessionWorkspaceStrategy
}

export interface SessionOutputEvent {
  sessionId: string
  data: string
}

export interface IdeTerminalOutputEvent {
  data: string
}

export interface SentinelApi {
  bootstrap: () => Promise<BootstrapPayload>
  selectProject: () => Promise<ProjectState>
  refreshProject: () => Promise<ProjectState>
  setDefaultSessionStrategy: (strategy: SessionWorkspaceStrategy) => Promise<WorkspacePreferences>
  createSession: (input?: CreateSessionInput) => Promise<SessionSummary>
  closeSession: (sessionId: string) => Promise<void>
  resizeSession: (sessionId: string, cols: number, rows: number) => Promise<void>
  sendInput: (sessionId: string, data: string) => Promise<void>
  ensureIdeTerminal: () => Promise<IdeTerminalState>
  resizeIdeTerminal: (cols: number, rows: number) => Promise<void>
  sendIdeTerminalInput: (data: string) => Promise<void>
  writeIdeFile: (relativePath: string, content: string) => Promise<void>
  applyIdeWorkspace: () => Promise<SessionApplyResult>
  discardIdeWorkspaceChanges: () => Promise<void>
  readFile: (filePath: string) => Promise<string>
  readFileDiff: (sessionId: string, filePath: string) => Promise<string>
  writeSessionFile: (sessionId: string, relativePath: string, content: string) => Promise<void>
  applySession: (sessionId: string) => Promise<SessionApplyResult>
  commitSession: (sessionId: string, message: string) => Promise<void>
  discardSessionChanges: (sessionId: string) => Promise<void>
  revealInFileExplorer: (filePath: string) => Promise<void>
  openInSystemEditor: (filePath: string) => Promise<void>
  onSessionOutput: (listener: (event: SessionOutputEvent) => void) => () => void
  onIdeTerminalOutput: (listener: (event: IdeTerminalOutputEvent) => void) => () => void
  onSessionState: (listener: (session: SessionSummary) => void) => () => void
  onIdeTerminalState: (listener: (state: IdeTerminalState) => void) => () => void
  onSessionMetrics: (listener: (payload: SessionMetricsUpdate) => void) => () => void
  onSessionHistory: (listener: (payload: SessionHistoryUpdate) => void) => () => void
  onSessionDiff: (listener: (payload: SessionDiffUpdate) => void) => () => void
  onWorkspaceState: (listener: (summary: WorkspaceSummary) => void) => () => void
  onActivityLog: (listener: (entry: ActivityLogEntry) => void) => () => void
}

declare global {
  interface Window {
    sentinel: SentinelApi
  }
}

export {}
