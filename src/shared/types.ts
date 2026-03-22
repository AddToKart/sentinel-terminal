export type SessionStatus = 'starting' | 'ready' | 'closing' | 'closed' | 'error'

export type CleanupState = 'active' | 'removed' | 'preserved' | 'failed'

export interface ProcessMetrics {
  cpuPercent: number
  memoryMb: number
  threadCount: number
  handleCount: number
  processCount: number
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
  worktreePath: string
  branchName: string
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
  projectPath?: string
  projectName?: string
  branch?: string
}

export interface ActivityLogEntry {
  id: string
  timestamp: number
  scope: 'git'
  status: 'started' | 'completed' | 'failed'
  command: string
  cwd: string
  detail?: string
}

export interface BootstrapPayload {
  project: ProjectState
  sessions: SessionSummary[]
  summary: WorkspaceSummary
  activityLog: ActivityLogEntry[]
}

export interface CreateSessionInput {
  label?: string
  startupCommand?: string
  cols?: number
  rows?: number
}

export interface SessionOutputEvent {
  sessionId: string
  data: string
}

export interface SentinelApi {
  bootstrap: () => Promise<BootstrapPayload>
  selectProject: () => Promise<ProjectState>
  refreshProject: () => Promise<ProjectState>
  createSession: (input?: CreateSessionInput) => Promise<SessionSummary>
  closeSession: (sessionId: string) => Promise<void>
  resizeSession: (sessionId: string, cols: number, rows: number) => Promise<void>
  sendInput: (sessionId: string, data: string) => Promise<void>
  revealInFileExplorer: (filePath: string) => Promise<void>
  openInSystemEditor: (filePath: string) => Promise<void>
  onSessionOutput: (listener: (event: SessionOutputEvent) => void) => () => void
  onSessionState: (listener: (session: SessionSummary) => void) => () => void
  onWorkspaceState: (listener: (summary: WorkspaceSummary) => void) => () => void
  onActivityLog: (listener: (entry: ActivityLogEntry) => void) => () => void
}

declare global {
  interface Window {
    sentinel: SentinelApi
  }
}

export {}
