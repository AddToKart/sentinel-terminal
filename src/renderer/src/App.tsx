import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  FolderOpen,
  GitBranch,
  PanelLeft,
  Plus,
  RefreshCw,
  Sparkles,
  TerminalSquare
} from 'lucide-react'

import type {
  ActivityLogEntry,
  ProjectState,
  SessionCommandEntry,
  SessionDiffUpdate,
  SessionHistoryUpdate,
  SessionMetricsUpdate,
  SessionSummary,
  WorkspaceSummary
} from '@shared/types'

const AgentDashboard = lazy(async () => {
  const module = await import('./components/AgentDashboard')
  return { default: module.AgentDashboard }
})

import { ConsoleDrawer } from './components/ConsoleDrawer'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { CodePreview } from './components/CodePreview'
import { GlobalActionBar } from './components/GlobalActionBar'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'

const emptyProject = (): ProjectState => ({
  isGitRepo: false,
  tree: []
})

const emptySummary = (): WorkspaceSummary => ({
  activeSessions: 0,
  totalCpuPercent: 0,
  totalMemoryMb: 0,
  totalProcesses: 0,
  lastUpdated: Date.now()
})

const emptyActivityLog = (): ActivityLogEntry[] => []

function upsertSession(current: SessionSummary[], incoming: SessionSummary): SessionSummary[] {
  const next = current.some((session) => session.id === incoming.id)
    ? current.map((session) => (session.id === incoming.id ? incoming : session))
    : [incoming, ...current]

  return next.sort((left, right) => right.createdAt - left.createdAt)
}

function applyMetricsUpdate(current: SessionSummary[], incoming: SessionMetricsUpdate): SessionSummary[] {
  return current.map((session) =>
    session.id === incoming.sessionId
      ? {
          ...session,
          pid: incoming.pid ?? session.pid,
          metrics: incoming.metrics
        }
      : session
  )
}

function projectSubtitle(project: ProjectState): string {
  if (!project.path) {
    return 'Open a Git repository to launch isolated agent worktrees.'
  }

  if (project.isGitRepo) {
    return project.branch ? `${project.name} on ${project.branch}` : `${project.name} in detached HEAD`
  }

  return `${project.name} folder view. Worktree sessions require Git.`
}

function historyMapFromPayload(
  payload: SessionHistoryUpdate[]
): Record<string, SessionCommandEntry[]> {
  return Object.fromEntries(payload.map((entry) => [entry.sessionId, entry.entries]))
}

function diffMapFromPayload(payload: SessionDiffUpdate[]): Record<string, string[]> {
  return Object.fromEntries(payload.map((entry) => [entry.sessionId, entry.modifiedPaths]))
}

function pruneKeyedState<T>(current: Record<string, T>, validIds: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(current).filter(([sessionId]) => validIds.has(sessionId)))
}

function buildDiffBadges(
  sessions: SessionSummary[],
  sessionDiffs: Record<string, string[]>
): Record<string, string[]> {
  const labelBySessionId = new Map(sessions.map((session) => [session.id, session.label.toUpperCase()]))
  const next: Record<string, string[]> = {}

  for (const [sessionId, modifiedPaths] of Object.entries(sessionDiffs)) {
    const label = labelBySessionId.get(sessionId)
    if (!label) {
      continue
    }

    for (const filePath of modifiedPaths) {
      next[filePath] = [...(next[filePath] ?? []), label]
    }
  }

  for (const filePath of Object.keys(next)) {
    next[filePath] = [...new Set(next[filePath])].sort((left, right) => left.localeCompare(right))
  }

  return next
}

export default function App(): JSX.Element {
  const [project, setProject] = useState<ProjectState>(emptyProject)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [summary, setSummary] = useState<WorkspaceSummary>(emptySummary)
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>(emptyActivityLog)
  const [sessionHistories, setSessionHistories] = useState<Record<string, SessionCommandEntry[]>>({})
  const [sessionDiffs, setSessionDiffs] = useState<Record<string, string[]>>({})
  const [creatingSession, setCreatingSession] = useState(false)
  const [refreshingProject, setRefreshingProject] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [fitNonce, setFitNonce] = useState(0)
  const [maximizedSessionId, setMaximizedSessionId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [globalActionBarOpen, setGlobalActionBarOpen] = useState(false)
  const shellViewportRef = useRef<HTMLDivElement | null>(null)
  const dashboardViewportRef = useRef<HTMLDivElement | null>(null)
  const consoleDrawerRef = useRef<HTMLDivElement | null>(null)
  const sessionIdSignature = sessions.map((session) => session.id).join('|')

  useEffect(() => {
    let disposed = false

    void window.sentinel
      .bootstrap()
      .then((payload) => {
        if (disposed) {
          return
        }

        setProject(payload.project)
        setSessions(payload.metrics.reduce(applyMetricsUpdate, payload.sessions))
        setSummary(payload.summary)
        setActivityLog(payload.activityLog)
        setSessionHistories(historyMapFromPayload(payload.histories))
        setSessionDiffs(diffMapFromPayload(payload.diffs))
      })
      .catch((error: unknown) => {
        if (disposed) {
          return
        }

        setErrorMessage(error instanceof Error ? error.message : 'Sentinel could not initialize.')
      })

    const removeSessionListener = window.sentinel.onSessionState((session) => {
      setSessions((current) => upsertSession(current, session))
    })

    const removeMetricsListener = window.sentinel.onSessionMetrics((payload) => {
      setSessions((current) => applyMetricsUpdate(current, payload))
    })

    const removeHistoryListener = window.sentinel.onSessionHistory((payload) => {
      setSessionHistories((current) => ({
        ...current,
        [payload.sessionId]: payload.entries
      }))
    })

    const removeDiffListener = window.sentinel.onSessionDiff((payload) => {
      setSessionDiffs((current) => ({
        ...current,
        [payload.sessionId]: payload.modifiedPaths
      }))
    })

    const removeWorkspaceListener = window.sentinel.onWorkspaceState((workspaceState) => {
      setSummary(workspaceState)
    })

    const removeActivityListener = window.sentinel.onActivityLog((entry) => {
      setActivityLog((current) => [entry, ...current].slice(0, 160))
    })

    return () => {
      disposed = true
      removeSessionListener()
      removeMetricsListener()
      removeHistoryListener()
      removeDiffListener()
      removeWorkspaceListener()
      removeActivityListener()
    }
  }, [])

  useEffect(() => {
    const validSessionIds = new Set(sessions.map((session) => session.id))

    setSessionHistories((current) => pruneKeyedState(current, validSessionIds))
    setSessionDiffs((current) => pruneKeyedState(current, validSessionIds))

    if (maximizedSessionId && !validSessionIds.has(maximizedSessionId)) {
      setMaximizedSessionId(null)
    }
  }, [sessionIdSignature, maximizedSessionId])

  useEffect(() => {
    const observedElements = [
      shellViewportRef.current,
      dashboardViewportRef.current,
      consoleDrawerRef.current
    ].filter((element): element is HTMLDivElement => Boolean(element))

    if (observedElements.length === 0) {
      return
    }

    let frameId = 0
    const triggerFit = (): void => {
      window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(() => {
        setFitNonce((current) => current + 1)
      })
    }

    const observer = new ResizeObserver(() => {
      triggerFit()
    })

    observedElements.forEach((element) => observer.observe(element))
    triggerFit()

    return () => {
      window.cancelAnimationFrame(frameId)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    const timerIds = [0, 180, 320].map((delay) =>
      window.setTimeout(() => {
        setFitNonce((current) => current + 1)
      }, delay)
    )

    return () => {
      timerIds.forEach((timerId) => window.clearTimeout(timerId))
    }
  }, [sidebarCollapsed, consoleOpen, sessions.length, maximizedSessionId])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey && event.code === 'KeyK') {
        event.preventDefault()
        setGlobalActionBarOpen((current) => !current)
        return
      }

      if (!event.ctrlKey || event.altKey || event.shiftKey || event.code !== 'Backquote') {
        return
      }

      event.preventDefault()
      setConsoleOpen((current) => !current)
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [])

  const globalActions = [
    { id: 'new-agent', label: 'New Agent', icon: <Plus className="h-4 w-4" />, execute: () => void handleCreateSession() },
    { id: 'open-project', label: 'Open Repository', icon: <FolderOpen className="h-4 w-4" />, execute: () => void handleOpenProject() },
    { id: 'refresh-project', label: 'Refresh Tree', icon: <RefreshCw className="h-4 w-4" />, execute: () => void handleRefreshProject() },
    { id: 'toggle-sidebar', label: 'Toggle Sidebar', icon: <PanelLeft className="h-4 w-4" />, execute: () => setSidebarCollapsed(c => !c) },
    { id: 'toggle-console', label: 'Toggle Console', icon: <TerminalSquare className="h-4 w-4" />, execute: () => setConsoleOpen(c => !c) },
  ]

  async function handleOpenProject(): Promise<void> {
    setErrorMessage(null)

    try {
      const nextProject = await window.sentinel.selectProject()
      setProject(nextProject)
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Sentinel could not open the selected folder.')
    }
  }

  async function handleRefreshProject(): Promise<void> {
    setErrorMessage(null)
    setRefreshingProject(true)

    try {
      const nextProject = await window.sentinel.refreshProject()
      setProject(nextProject)
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Sentinel could not refresh the project tree.')
    } finally {
      setRefreshingProject(false)
    }
  }

  async function handleCreateSession(): Promise<void> {
    setErrorMessage(null)
    setCreatingSession(true)

    try {
      let activeProject = project
      if (!activeProject.path) {
        activeProject = await window.sentinel.selectProject()
        setProject(activeProject)
      }

      if (!activeProject.isGitRepo) {
        throw new Error('Sentinel needs a Git repository to create an isolated worktree-backed session.')
      }

      const session = await window.sentinel.createSession()
      setSessions((current) => upsertSession(current, session))
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Sentinel could not create the agent session.')
    } finally {
      setCreatingSession(false)
    }
  }

  async function handleCloseSession(sessionId: string): Promise<void> {
    setErrorMessage(null)

    try {
      await window.sentinel.closeSession(sessionId)
      setSessions((current) => {
        const nextSessions = current.filter((session) => session.id !== sessionId)
        const nextSessionIds = new Set(nextSessions.map((session) => session.id))
        setSessionHistories((history) => pruneKeyedState(history, nextSessionIds))
        setSessionDiffs((diffs) => pruneKeyedState(diffs, nextSessionIds))
        return nextSessions
      })
      if (maximizedSessionId === sessionId) {
        setMaximizedSessionId(null)
      }
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Sentinel could not close the agent session.')
    }
  }

  const hasProject = Boolean(project.path)
  const diffBadges = buildDiffBadges(sessions, sessionDiffs)

  return (
    <div className="app-shell h-[100dvh] max-h-[100dvh] overflow-hidden bg-noise text-white">
      <div
        className="grid h-full min-h-0 overflow-hidden transition-[grid-template-columns] duration-300 ease-out"
        style={{
          gridTemplateColumns: sidebarCollapsed ? '84px minmax(0, 1fr)' : '320px minmax(0, 1fr)'
        }}
      >
        <Sidebar
          collapsed={sidebarCollapsed}
          diffBadges={diffBadges}
          onOpenProject={handleOpenProject}
          onRefreshProject={handleRefreshProject}
          onToggleCollapse={() => {
            setSidebarCollapsed((current) => !current)
          }}
          project={project}
          refreshing={refreshingProject}
          onFileSelect={setSelectedFilePath}
        />

        <div
          className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-hidden"
          ref={shellViewportRef}
        >
          <header className="shrink-0 border-b border-white/10 bg-sentinel-ink/55 px-8 pb-6 pt-12 backdrop-blur-xl">
            <div className="flex items-start justify-between gap-6">
              <div className="space-y-4">
                <div className="inline-flex items-center gap-2 border border-sentinel-accent/30 bg-sentinel-accent/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.22em] text-sentinel-glow">
                  <Sparkles className="h-3.5 w-3.5" />
                  Sentinel
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <h1 className="text-3xl font-semibold tracking-tight text-white">Agent Worktree Dashboard</h1>
                    {project.isGitRepo && (
                      <div className="inline-flex items-center gap-2 border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-sentinel-mist">
                        <GitBranch className="h-3.5 w-3.5" />
                        {project.branch || 'detached HEAD'}
                      </div>
                    )}
                  </div>

                  <p className="max-w-3xl text-sm leading-6 text-sentinel-mist">{projectSubtitle(project)}</p>
                </div>

                {errorMessage && (
                  <div className="inline-flex max-w-3xl items-center gap-2 border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                    <ArrowRight className="h-4 w-4 rotate-180" />
                    {errorMessage}
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <button
                  className="action-button"
                  onClick={() => {
                    setSidebarCollapsed((current) => !current)
                  }}
                  type="button"
                >
                  <PanelLeft className="h-4 w-4" />
                  {sidebarCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
                </button>

                <button
                  className="action-button"
                  onClick={() => {
                    void handleRefreshProject()
                  }}
                  type="button"
                >
                  <RefreshCw className={`h-4 w-4 ${refreshingProject ? 'animate-spin' : ''}`} />
                  Refresh
                </button>

                <button
                  className="inline-flex items-center gap-2 border border-sentinel-accent/30 bg-sentinel-accent px-5 py-3 text-sm font-semibold text-sentinel-ink transition hover:bg-sentinel-glow disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={creatingSession}
                  onClick={() => {
                    void handleCreateSession()
                  }}
                  type="button"
                >
                  <Plus className="h-4 w-4" />
                  {creatingSession ? 'Starting Agent...' : 'New Agent'}
                </button>
              </div>
            </div>
          </header>

          <main className="min-h-0 overflow-hidden px-8 py-6" ref={dashboardViewportRef}>
            {!hasProject && (
              <section className="panel flex h-full min-h-0 flex-col items-center justify-center gap-6 border-dashed text-center">
                <div className="border border-white/10 bg-white/[0.04] p-5">
                  <FolderOpen className="h-10 w-10 text-sentinel-accent" />
                </div>

                <div className="space-y-3">
                  <h2 className="text-2xl font-semibold text-white">Open a repository to begin</h2>
                  <p className="max-w-xl text-sm leading-6 text-sentinel-mist">
                    Sentinel creates a temporary Git worktree for each agent shell so parallel edits stay isolated,
                    inspectable, and easy to merge back later.
                  </p>
                </div>

                <button
                  className="inline-flex items-center gap-2 border border-white/10 bg-white/[0.05] px-5 py-3 text-sm font-medium text-white transition hover:border-sentinel-accent/50 hover:bg-sentinel-accent/10"
                  onClick={() => {
                    void handleOpenProject()
                  }}
                  type="button"
                >
                  <FolderOpen className="h-4 w-4" />
                  Open Repository
                </button>
              </section>
            )}

            {hasProject && sessions.length === 0 && (
              <section className="panel flex h-full min-h-0 flex-col justify-between overflow-hidden">
                <div className="space-y-5 p-8">
                  <div className="inline-flex items-center gap-2 border border-white/10 bg-white/[0.04] px-3 py-1 text-xs uppercase tracking-[0.22em] text-sentinel-mist">
                    <TerminalSquare className="h-3.5 w-3.5" />
                    Live Tiling
                  </div>
                  <div className="space-y-3">
                    <h2 className="text-2xl font-semibold text-white">No active agents yet</h2>
                    <p className="max-w-2xl text-sm leading-7 text-sentinel-mist">
                      Start a tile to create a fresh worktree, boot a PowerShell terminal inside it, and launch any CLI
                      agent you want. Sentinel keeps the shell live, streams true per-process resource usage, and
                      surfaces worktree diffs directly in the project tree.
                    </p>
                  </div>
                </div>

                <div className="grid gap-4 border-t border-white/10 bg-white/[0.02] p-8 lg:grid-cols-[1.1fr_0.9fr]">
                  <div className="space-y-3">
                    <div className="text-sm font-medium text-white">Suggested session flow</div>
                    <div className="flex flex-wrap gap-3 text-sm text-sentinel-mist">
                      <span className="metric-pill">1. Create worktree</span>
                      <span className="metric-pill">2. Launch agent CLI</span>
                      <span className="metric-pill">3. Review isolated diff</span>
                      <span className="metric-pill">4. Merge or discard</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-start lg:justify-end">
                    <button
                      className="inline-flex items-center gap-2 border border-sentinel-accent/30 bg-sentinel-accent px-5 py-3 text-sm font-semibold text-sentinel-ink transition hover:bg-sentinel-glow"
                      onClick={() => {
                        void handleCreateSession()
                      }}
                      type="button"
                    >
                      <Plus className="h-4 w-4" />
                      Start First Agent
                    </button>
                  </div>
                </div>
              </section>
            )}

            {hasProject && sessions.length > 0 && (
              <Suspense
                fallback={
                  <section className="panel flex h-full min-h-0 items-center justify-center text-sm text-sentinel-mist">
                    Loading terminal surfaces...
                  </section>
                }
              >
                {selectedFilePath ? (
                  <PanelGroup direction="vertical" autoSaveId="sentinel-split-view">
                    <Panel defaultSize={60} minSize={20} className="min-h-0 relative">
                      <AgentDashboard
                        fitNonce={fitNonce}
                        histories={sessionHistories}
                        maximizedSessionId={maximizedSessionId}
                        onClose={handleCloseSession}
                        onToggleMaximize={(sessionId) => {
                          setMaximizedSessionId((current) => (current === sessionId ? null : sessionId))
                        }}
                        sessions={sessions}
                      />
                    </Panel>
                    <PanelResizeHandle className="h-2 bg-transparent hover:bg-sentinel-accent/20 cursor-row-resize transition-colors" />
                    <Panel defaultSize={40} minSize={20} className="min-h-0 relative">
                      <CodePreview 
                        filePath={selectedFilePath} 
                        projectPath={project.path}
                        sessions={sessions} 
                        onClose={() => setSelectedFilePath(null)} 
                      />
                    </Panel>
                  </PanelGroup>
                ) : (
                  <AgentDashboard
                    fitNonce={fitNonce}
                    histories={sessionHistories}
                    maximizedSessionId={maximizedSessionId}
                    onClose={handleCloseSession}
                    onToggleMaximize={(sessionId) => {
                      setMaximizedSessionId((current) => (current === sessionId ? null : sessionId))
                    }}
                    sessions={sessions}
                  />
                )}
              </Suspense>
            )}
          </main>

          <div className="min-h-0 overflow-hidden" ref={consoleDrawerRef}>
            <ConsoleDrawer
              entries={activityLog}
              open={consoleOpen}
              onToggleOpen={() => {
                setConsoleOpen((current) => !current)
              }}
            />
          </div>

          <StatusBar
            consoleOpen={consoleOpen}
            onToggleConsole={() => {
              setConsoleOpen((current) => !current)
            }}
            summary={summary}
          />
        </div>
      </div>

      <GlobalActionBar 
        isOpen={globalActionBarOpen} 
        onClose={() => setGlobalActionBarOpen(false)} 
        actions={globalActions} 
      />
    </div>
  )
}
