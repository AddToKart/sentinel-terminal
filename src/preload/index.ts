import { contextBridge, ipcRenderer } from 'electron'

import type {
  ActivityLogEntry,
  BootstrapPayload,
  CreateSessionInput,
  ProjectState,
  SessionDiffUpdate,
  SessionHistoryUpdate,
  SessionMetricsUpdate,
  SentinelApi,
  SessionOutputEvent,
  SessionSummary,
  WorkspaceSummary
} from '@shared/types'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrappedListener = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrappedListener)

  return () => {
    ipcRenderer.off(channel, wrappedListener)
  }
}

const api: SentinelApi = {
  bootstrap: () => ipcRenderer.invoke('sentinel:bootstrap') as Promise<BootstrapPayload>,
  selectProject: () => ipcRenderer.invoke('sentinel:select-project') as Promise<ProjectState>,
  refreshProject: () => ipcRenderer.invoke('sentinel:refresh-project') as Promise<ProjectState>,
  createSession: (input?: CreateSessionInput) =>
    ipcRenderer.invoke('sentinel:create-session', input) as Promise<SessionSummary>,
  closeSession: (sessionId: string) => ipcRenderer.invoke('sentinel:close-session', sessionId) as Promise<void>,
  resizeSession: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('sentinel:resize-session', { sessionId, cols, rows }) as Promise<void>,
  sendInput: (sessionId: string, data: string) =>
    ipcRenderer.invoke('sentinel:send-input', { sessionId, data }) as Promise<void>,
  readFile: (filePath: string) =>
    ipcRenderer.invoke('sentinel:read-file', filePath) as Promise<string>,
  readFileDiff: (sessionId: string, filePath: string) =>
    ipcRenderer.invoke('sentinel:read-file-diff', { sessionId, filePath }) as Promise<string>,
  mergeWorktree: (sessionId: string) =>
    ipcRenderer.invoke('sentinel:merge-worktree', sessionId) as Promise<void>,
  revealInFileExplorer: (filePath: string) =>
    ipcRenderer.invoke('sentinel:reveal-in-file-explorer', filePath) as Promise<void>,
  openInSystemEditor: (filePath: string) =>
    ipcRenderer.invoke('sentinel:open-in-system-editor', filePath) as Promise<void>,
  onSessionOutput: (listener: (event: SessionOutputEvent) => void) =>
    subscribe<SessionOutputEvent>('sentinel:session-output', listener),
  onSessionState: (listener: (session: SessionSummary) => void) =>
    subscribe<SessionSummary>('sentinel:session-state', listener),
  onSessionMetrics: (listener: (payload: SessionMetricsUpdate) => void) =>
    subscribe<SessionMetricsUpdate>('sentinel:session-metrics', listener),
  onSessionHistory: (listener: (payload: SessionHistoryUpdate) => void) =>
    subscribe<SessionHistoryUpdate>('sentinel:session-history', listener),
  onSessionDiff: (listener: (payload: SessionDiffUpdate) => void) =>
    subscribe<SessionDiffUpdate>('sentinel:session-diff', listener),
  onWorkspaceState: (listener: (summary: WorkspaceSummary) => void) =>
    subscribe<WorkspaceSummary>('sentinel:workspace-state', listener),
  onActivityLog: (listener: (entry: ActivityLogEntry) => void) =>
    subscribe<ActivityLogEntry>('sentinel:activity-log', listener)
}

contextBridge.exposeInMainWorld('sentinel', api)
