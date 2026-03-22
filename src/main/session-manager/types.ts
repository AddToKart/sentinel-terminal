import type { IPty } from 'node-pty'

import type {
  ActivityLogEntry,
  IdeTerminalOutputEvent,
  IdeTerminalState,
  SessionCommandEntry,
  SessionDiffUpdate,
  SessionHistoryUpdate,
  SessionMetricsUpdate,
  SessionSummary,
  WorkspaceSummary
} from '@shared/types'

export interface ProcessTreeSnapshot {
  rootId: number
  cpuTotalSeconds: number
  workingSetBytes: number
  handleCount: number
  threadCount: number
  processCount: number
  processIds: number[]
}

export interface RawProcessTreeSnapshot {
  RootId: number
  CpuTotalSeconds: number
  WorkingSetBytes: number
  HandleCount: number
  ThreadCount: number
  ProcessCount: number
  ProcessIds: number[]
}

export interface SessionRecord {
  summary: SessionSummary
  terminal: IPty
  closePromise: Promise<void>
  resolveClosed: () => void
  closeRequested: boolean
  finalized: boolean
  commandBuffer: string
  history: SessionCommandEntry[]
  modifiedPaths: string[]
  sandboxState?: SandboxWorkspaceState
  finalizePromise?: Promise<void>
}

export interface IdeTerminalRecord {
  state: IdeTerminalState
  terminal: IPty
  closePromise: Promise<void>
  resolveClosed: () => void
  closeRequested: boolean
  sandboxState?: SandboxWorkspaceState
  finalizePromise?: Promise<void>
}

export interface FileFingerprint {
  signature: string
  hash: string
}

export interface SandboxWorkspaceState {
  baselineHashes: Map<string, string>
  scanCache: Map<string, FileFingerprint>
  sharedDirectories: string[]
}

export type ManagerEvents = {
  'session-output': [{ sessionId: string; data: string }]
  'session-state': [SessionSummary]
  'ide-terminal-output': [IdeTerminalOutputEvent]
  'ide-terminal-state': [IdeTerminalState]
  'session-metrics': [SessionMetricsUpdate]
  'session-history': [SessionHistoryUpdate]
  'session-diff': [SessionDiffUpdate]
  'workspace-state': [WorkspaceSummary]
  'activity-log': [ActivityLogEntry]
}
