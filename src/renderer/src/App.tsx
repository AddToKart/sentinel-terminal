import { Suspense, lazy, useEffect, useState } from 'react'
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

import type { ActivityLogEntry, ProjectState, SessionSummary, WorkspaceSummary } from '@shared/types'

const AgentDashboard = lazy(async () => {
  const module = await import('./components/AgentDashboard')
  return { default: module.AgentDashboard }
})

import { Sidebar } from './components/Sidebar'
import { ActivityLog } from './components/ActivityLog'
import { StatusBar } from './components/StatusBar'

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

function projectSubtitle(project: ProjectState): string {
  if (!project.path) {
    return 'Open a Git repository to launch isolated agent worktrees.'
  }

  if (project.isGitRepo) {
    return project.branch ? `${project.name} on ${project.branch}` : `${project.name} in detached HEAD`
  }

  return `${project.name} folder view. Worktree sessions require Git.`
}

export default function App(): JSX.Element {
  const [project, setProject] = useState<ProjectState>(emptyProject)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [summary, setSummary] = useState<WorkspaceSummary>(emptySummary)
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>(emptyActivityLog)
  const [creatingSession, setCreatingSession] = useState(false)
  const [refreshingProject, setRefreshingProject] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [fitNonce, setFitNonce] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false

    void window.sentinel
      .bootstrap()
      .then((payload) => {
        if (disposed) {
          return
        }

        setProject(payload.project)
        setSessions(payload.sessions)
        setSummary(payload.summary)
        setActivityLog(payload.activityLog)
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

    const removeWorkspaceListener = window.sentinel.onWorkspaceState((workspaceState) => {
      setSummary(workspaceState)
    })

    const removeActivityListener = window.sentinel.onActivityLog((entry) => {
      setActivityLog((current) => [entry, ...current].slice(0, 120))
    })

    return () => {
      disposed = true
      removeSessionListener()
      removeWorkspaceListener()
      removeActivityListener()
    }
  }, [])

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      setFitNonce((current) => current + 1)
    })
    const timeout = window.setTimeout(() => {
      setFitNonce((current) => current + 1)
    }, 320)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.clearTimeout(timeout)
    }
  }, [sidebarCollapsed, sessions.length])

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
      setSessions((current) => current.filter((session) => session.id !== sessionId))
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Sentinel could not close the agent session.')
    }
  }

  const hasProject = Boolean(project.path)

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
          onOpenProject={handleOpenProject}
          onRefreshProject={handleRefreshProject}
          onToggleCollapse={() => {
            setSidebarCollapsed((current) => !current)
          }}
          project={project}
          refreshing={refreshingProject}
        />

        <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_148px_auto] overflow-hidden">
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

          <main className="min-h-0 overflow-hidden px-8 py-6">
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
                      agent you want. Sentinel keeps the shell live, surfaces process usage, and preserves dirty
                      worktrees instead of deleting in-progress edits.
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
                <AgentDashboard
                  fitNonce={fitNonce}
                  onClose={handleCloseSession}
                  sessions={sessions}
                />
              </Suspense>
            )}
          </main>

          <ActivityLog entries={activityLog} />
          <StatusBar summary={summary} />
        </div>
      </div>
    </div>
  )
}
