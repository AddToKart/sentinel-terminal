import { Suspense, useEffect, useRef, useState } from 'react'
import { FolderOpen, GitBranch, PanelLeft, Plus, RefreshCw, TerminalSquare } from 'lucide-react'
import { ImperativePanelHandle, Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'

import { AgentDashboard } from './components/AgentDashboard'
import { CodePreview } from './components/CodePreview'
import { ConsoleDrawer } from './components/ConsoleDrawer'
import { GlobalActionBar } from './components/GlobalActionBar'
import { SessionTile } from './components/SessionTile'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { clearSessionOutput } from './terminal-stream'

import type {
  ActivityLogEntry,
  ProjectState,
  SessionCommandEntry,
  SessionSummary,
  SessionWorkspaceStrategy,
  WorkspaceSummary
} from '@shared/types'

const emptyProject = (): ProjectState => ({
  isGitRepo: false,
  tree: [],
  name: undefined,
  path: undefined,
  branch: undefined
})

const defaultSummary = (): WorkspaceSummary => ({
  activeSessions: 0,
  totalCpuPercent: 0,
  totalMemoryMb: 0,
  totalProcesses: 0,
  lastUpdated: Date.now(),
  defaultSessionStrategy: 'sandbox-copy'
})

export default function App(): JSX.Element {
  const [project, setProject] = useState<ProjectState>(emptyProject())
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [workspaceSummary, setWorkspaceSummary] = useState<WorkspaceSummary>(defaultSummary())
  const [sessionHistories, setSessionHistories] = useState<Record<string, SessionCommandEntry[]>>({})
  const [sessionDiffs, setSessionDiffs] = useState<Record<string, string[]>>({})
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([])

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [fitNonce, setFitNonce] = useState(0)
  const [maximizedSessionId, setMaximizedSessionId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [globalActionBarOpen, setGlobalActionBarOpen] = useState(false)
  const [globalMode, setGlobalMode] = useState<'multiplex' | 'ide'>('multiplex')
  const [refreshingProject, setRefreshingProject] = useState(false)
  const [defaultSessionStrategy, setDefaultSessionStrategy] = useState<SessionWorkspaceStrategy>('sandbox-copy')

  const sidebarPanelRef = useRef<ImperativePanelHandle | null>(null)
  const shellViewportRef = useRef<HTMLDivElement | null>(null)
  const fitTimerRef = useRef<number | null>(null)

  function requestTerminalFit(delay = 80) {
    if (fitTimerRef.current) {
      window.clearTimeout(fitTimerRef.current)
    }

    fitTimerRef.current = window.setTimeout(() => {
      fitTimerRef.current = null
      setFitNonce((n) => n + 1)
    }, delay)
  }

  // Bootstrap
  useEffect(() => {
    let disposed = false

    const unsubs = [
      window.sentinel.onActivityLog((entry) => {
        setActivityLog((cur) => {
          const i = cur.findIndex((e) => e.id === entry.id)
          if (i >= 0) { const n = [...cur]; n[i] = entry; return n }
          return [entry, ...cur].slice(0, 100)
        })
      }),
      window.sentinel.onWorkspaceState(setWorkspaceSummary),
      window.sentinel.onSessionState((session) => {
        setSessions((cur) => {
          const i = cur.findIndex((s) => s.id === session.id)
          if (i >= 0) { const n = [...cur]; n[i] = session; return n }
          return [...cur, session]
        })
      }),
      window.sentinel.onSessionDiff((u) => {
        setSessionDiffs((cur) => ({ ...cur, [u.sessionId]: u.modifiedPaths }))
      }),
      window.sentinel.onSessionHistory((u) => {
        setSessionHistories((cur) => ({ ...cur, [u.sessionId]: u.entries }))
      }),
      window.sentinel.onSessionMetrics((u) => {
        setSessions((cur) => {
          const i = cur.findIndex((s) => s.id === u.sessionId)
          if (i >= 0) { const n = [...cur]; n[i] = { ...n[i], metrics: u.metrics, pid: u.pid ?? n[i].pid }; return n }
          return cur
        })
      })
    ]

    async function init() {
      try {
        const payload = await window.sentinel.bootstrap()
        if (disposed) return
        setProject(payload.project)
        setSessions(payload.sessions)
        setWorkspaceSummary(payload.summary)
        setActivityLog(payload.activityLog)
        setDefaultSessionStrategy(payload.preferences.defaultSessionStrategy)

        const histories: Record<string, SessionCommandEntry[]> = {}
        for (const u of payload.histories) histories[u.sessionId] = u.entries
        setSessionHistories(histories)

        const diffs: Record<string, string[]> = {}
        for (const u of payload.diffs) diffs[u.sessionId] = u.modifiedPaths
        setSessionDiffs(diffs)
      } catch {
        if (disposed) return
        setErrorMessage('Failed to initialize Sentinel.')
      }
    }
    void init()

    return () => {
      disposed = true
      unsubs.forEach((fn) => fn())
    }
  }, [])

  // Global ResizeObserver to re-fit terminals after any layout change
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      requestTerminalFit()
    })
    if (shellViewportRef.current) observer.observe(shellViewportRef.current)
    return () => {
      observer.disconnect()
      if (fitTimerRef.current) {
        window.clearTimeout(fitTimerRef.current)
        fitTimerRef.current = null
      }
    }
  }, [])

  // Trigger a re-fit when sidebar or console changes
  useEffect(() => {
    requestTerminalFit(120)
  }, [sidebarCollapsed, consoleOpen, globalMode, sessions.length, maximizedSessionId])

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.code === 'KeyK') { e.preventDefault(); setGlobalActionBarOpen((v) => !v); return }
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'Backquote') { e.preventDefault(); setConsoleOpen((v) => !v) }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])

  // Sidebar panel imperative API
  function toggleSidebar() {
    if (sidebarCollapsed) {
      sidebarPanelRef.current?.expand()
    } else {
      sidebarPanelRef.current?.collapse()
    }
    setSidebarCollapsed((v) => !v)
  }

  async function handleOpenProject() {
    try { const p = await window.sentinel.selectProject(); setProject(p); setSelectedFilePath(null) }
    catch (e: any) { if (e.message !== 'Dialog cancelled') setErrorMessage(`Failed to open project: ${e.message}`) }
  }

  async function handleRefreshProject() {
    if (!project.path) return
    setRefreshingProject(true)
    try { setProject(await window.sentinel.refreshProject()) }
    catch (e: any) { setErrorMessage(`Failed to refresh: ${e.message}`) }
    finally { setRefreshingProject(false) }
  }

  async function handleCreateSession() {
    if (!project.path) return
    try { await window.sentinel.createSession({ workspaceStrategy: defaultSessionStrategy }) }
    catch (e: any) { setErrorMessage(`Failed to start session: ${e.message}`) }
  }

  async function handleCloseSession(sessionId: string) {
    if (maximizedSessionId === sessionId) setMaximizedSessionId(null)
    try {
      await window.sentinel.closeSession(sessionId)
      clearSessionOutput(sessionId)
      setSessions((cur) => cur.filter((session) => session.id !== sessionId))
      setSessionHistories((cur) => {
        const next = { ...cur }
        delete next[sessionId]
        return next
      })
      setSessionDiffs((cur) => {
        const next = { ...cur }
        delete next[sessionId]
        return next
      })
    }
    catch (e: any) { setErrorMessage(`Failed to close session: ${e.message}`) }
  }

  async function handleChangeDefaultSessionStrategy(strategy: SessionWorkspaceStrategy) {
    try {
      const nextPreferences = await window.sentinel.setDefaultSessionStrategy(strategy)
      setDefaultSessionStrategy(nextPreferences.defaultSessionStrategy)
    } catch (e: any) {
      setErrorMessage(`Failed to update workspace strategy: ${e.message}`)
    }
  }

  const globalActions = [
    { id: 'new-agent', label: 'New Agent', icon: <Plus className="h-4 w-4" />, execute: () => void handleCreateSession() },
    { id: 'open-project', label: 'Open Repository', icon: <FolderOpen className="h-4 w-4" />, execute: () => void handleOpenProject() },
    { id: 'refresh-project', label: 'Refresh Tree', icon: <RefreshCw className="h-4 w-4" />, execute: () => void handleRefreshProject() },
    { id: 'toggle-sidebar', label: 'Toggle Sidebar', icon: <PanelLeft className="h-4 w-4" />, execute: toggleSidebar },
    { id: 'toggle-console', label: 'Toggle Console', icon: <TerminalSquare className="h-4 w-4" />, execute: () => setConsoleOpen((v) => !v) },
    { id: 'sandbox-mode', label: 'Use Sandbox Copy', icon: <TerminalSquare className="h-4 w-4" />, execute: () => void handleChangeDefaultSessionStrategy('sandbox-copy') },
    { id: 'worktree-mode', label: 'Use Git Worktree', icon: <TerminalSquare className="h-4 w-4" />, execute: () => void handleChangeDefaultSessionStrategy('git-worktree') },
    { id: 'ide-mode', label: 'Switch to IDE Mode', icon: <TerminalSquare className="h-4 w-4" />, execute: () => setGlobalMode('ide') },
    { id: 'multiplex-mode', label: 'Switch to Multiplex Mode', icon: <TerminalSquare className="h-4 w-4" />, execute: () => setGlobalMode('multiplex') },
  ]

  const hasProject = Boolean(project.path)
  const diffBadges = Object.fromEntries(
    Object.values(sessionDiffs)
      .flat()
      .map((relativePath) => [
        project.path ? `${project.path.replace(/[\/\\]$/, '')}\\${relativePath.replace(/\//g, '\\')}` : relativePath,
        ['modified']
      ])
  )

  // The active IDE session (for the bottom tray)
  const ideSession = sessions.find((s) => s.id === maximizedSessionId) ?? sessions[0] ?? null

  const multiplexContent = !hasProject ? (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-xs text-center p-8 border border-white/10 bg-white/[0.02]">
        <FolderOpen className="mx-auto mb-4 h-10 w-10 text-sentinel-mist/40" />
        <h2 className="mb-2 text-base font-bold text-white/90">Open a Repository</h2>
        <p className="mb-6 text-sm text-sentinel-mist">Select a project folder to start sandbox-copy or Git worktree agent sessions.</p>
        <button
          className="inline-flex h-9 w-full items-center justify-center gap-2 bg-white text-sm font-bold text-sentinel-ink hover:bg-white/90 transition"
          onClick={() => void handleOpenProject()}
        >
          Open Project
        </button>
      </div>
    </div>
  ) : sessions.length === 0 ? (
    <div className="flex h-full items-center justify-center text-center text-sentinel-mist">
      <div>
        <TerminalSquare className="mx-auto mb-4 h-10 w-10 opacity-30" />
        <p className="text-sm">No active agents yet. Start one with <strong className="text-white">New Agent</strong> using the workspace strategy selected in the sidebar.</p>
      </div>
    </div>
  ) : (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-sentinel-mist">Loading...</div>}>
      <AgentDashboard
        fitNonce={fitNonce}
        histories={sessionHistories}
        sessionDiffs={sessionDiffs}
        maximizedSessionId={maximizedSessionId}
        onClose={handleCloseSession}
        onToggleMaximize={(id) => setMaximizedSessionId((c) => c === id ? null : id)}
        sessions={sessions}
      />
    </Suspense>
  )

  const ideContent = (
    <PanelGroup direction="vertical" autoSaveId="sentinel-ide-layout">
      <Panel defaultSize={65} minSize={20} className="min-h-0">
        <CodePreview
          filePath={selectedFilePath}
          projectPath={project.path}
          sessions={sessions}
          onClose={() => setSelectedFilePath(null)}
        />
      </Panel>
      <PanelResizeHandle className="h-[3px] bg-transparent hover:bg-sentinel-accent/20 active:bg-sentinel-accent/40 transition-colors cursor-row-resize" />
      <Panel defaultSize={35} minSize={10} className="min-h-0">
        {ideSession ? (
          <SessionTile
            session={ideSession}
            historyEntries={sessionHistories[ideSession.id] ?? []}
            modifiedPaths={sessionDiffs[ideSession.id] ?? []}
            isMaximized={false}
            onClose={handleCloseSession}
            onToggleMaximize={(id) => setMaximizedSessionId((c) => c === id ? null : id)}
            applySession={() => window.sentinel.applySession(ideSession.id)}
            commitSession={(msg) => window.sentinel.commitSession(ideSession.id, msg)}
            discardSessionChanges={() => window.sentinel.discardSessionChanges(ideSession.id)}
            fitNonce={fitNonce}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-sentinel-mist bg-[#060a0f] border-t border-white/10">
            No active agents
          </div>
        )}
      </Panel>
    </PanelGroup>
  )

  return (
    <div className="flex h-[100dvh] w-screen flex-col overflow-hidden bg-[#060a0f] text-white select-none">
      {errorMessage && (
        <div className="shrink-0 bg-rose-500/10 px-4 py-2 text-sm text-rose-200 border-b border-rose-500/20">
          {errorMessage}
          <button className="ml-3 underline opacity-70 hover:opacity-100" onClick={() => setErrorMessage(null)}>dismiss</button>
        </div>
      )}

      {/* ============ TOP HEADER — draggable titlebar ============ */}
      {/*
       * Layout strategy:
               *  - The entire bar is draggable
       *  - Left cluster: sidebar toggle + project info (no-drag)
       *  - Right: padding-only safe zone (≥140px) for Electron controls (never house buttons there)
       */}
      <header
        className="shrink-0 relative flex items-center border-b border-white/10 bg-black/30 px-3 h-10"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* LEFT CLUSTER — sidebar toggle + project  */}
        <div
          className="flex items-center gap-3 min-w-0 z-10"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            className="shrink-0 inline-flex h-7 w-7 items-center justify-center text-sentinel-mist transition hover:text-white"
            onClick={toggleSidebar}
            title="Toggle sidebar"
          >
            <PanelLeft className="h-4 w-4" />
          </button>

          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold tracking-tight text-white/90 whitespace-nowrap">Sentinel</span>
            {project.name && (
              <div className="flex items-center gap-1.5 rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-sentinel-mist truncate max-w-[220px]">
                <GitBranch className="h-3 w-3 shrink-0" />
                <span className="truncate">{project.name} · {project.branch}</span>
              </div>
            )}
          </div>

          {/* Action buttons — in safe left zone */}
          <div className="flex items-center gap-1.5 ml-2">
            <button
              className="inline-flex h-7 items-center gap-1.5 rounded border border-sentinel-accent/30 bg-sentinel-accent/10 px-3 text-[11px] font-semibold text-sentinel-glow transition hover:bg-sentinel-accent/20 disabled:opacity-40"
              disabled={!hasProject}
              onClick={() => void handleCreateSession()}
            >
              <Plus className="h-3 w-3" />
              New Agent
            </button>
            <button
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-white/10 bg-white/[0.04] text-sentinel-mist transition hover:text-white disabled:opacity-40"
              disabled={!hasProject}
              onClick={() => void handleRefreshProject()}
              title="Refresh project tree"
            >
              <RefreshCw className={`h-3 w-3 ${refreshingProject ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* RIGHT SAFE ZONE — deliberately empty, ≥140px reserved for Electron window controls (min/max/close) */}
        <div className="ml-auto w-[140px] shrink-0" />
      </header>

      {/* ============ BODY ============ */}
      <div className="flex flex-1 min-h-0 overflow-hidden" ref={shellViewportRef}>

        {/* Resizable panel group: Sidebar | Main */}
        <PanelGroup direction="horizontal" autoSaveId="sentinel-sidebar">
          <Panel
            ref={sidebarPanelRef}
            defaultSize={18}
            minSize={0}
            collapsible
            collapsedSize={0}
            onCollapse={() => setSidebarCollapsed(true)}
            onExpand={() => setSidebarCollapsed(false)}
            className="transition-[width] duration-200"
            style={{ overflow: 'hidden' }}
          >
            <Sidebar
              collapsed={false}
              diffBadges={diffBadges}
              defaultSessionStrategy={defaultSessionStrategy}
              onOpenProject={handleOpenProject}
              onRefreshProject={handleRefreshProject}
              onChangeDefaultSessionStrategy={(strategy) => { void handleChangeDefaultSessionStrategy(strategy) }}
              onToggleCollapse={toggleSidebar}
              project={project}
              refreshing={refreshingProject}
              onFileSelect={(path) => { setSelectedFilePath(path); setGlobalMode('ide') }}
              globalMode={globalMode}
              onToggleGlobalMode={setGlobalMode}
            />
          </Panel>

          <PanelResizeHandle className="relative w-[3px] bg-transparent hover:bg-sentinel-accent/20 active:bg-sentinel-accent/40 transition-colors" />

          <Panel className="flex flex-col min-h-0 min-w-0" defaultSize={82}>
            <div className="flex-1 min-h-0 overflow-hidden">
              {globalMode === 'multiplex' ? multiplexContent : ideContent}
            </div>

            {/* ---- STATUS BAR ---- */}
            <StatusBar
              consoleOpen={consoleOpen}
              defaultSessionStrategy={defaultSessionStrategy}
              onToggleConsole={() => setConsoleOpen((v) => !v)}
              summary={workspaceSummary}
            />
          </Panel>
        </PanelGroup>
      </div>

      {/* ============ CONSOLE DRAWER ============ */}
      <div
        className={`fixed inset-x-0 bottom-0 z-40 flex h-[36vh] flex-col overflow-hidden bg-[#060c14]/98 shadow-2xl backdrop-blur-2xl transition-transform duration-300 ease-in-out ${
          consoleOpen ? 'translate-y-0 border-t border-sentinel-accent/20' : 'translate-y-full'
        }`}
      >
        <ConsoleDrawer
          entries={activityLog}
          open={consoleOpen}
          onToggleOpen={() => setConsoleOpen((v) => !v)}
        />
      </div>

      {/* ============ GLOBAL ACTION BAR ============ */}
      <GlobalActionBar
        isOpen={globalActionBarOpen}
        onClose={() => setGlobalActionBarOpen(false)}
        actions={globalActions}
      />
    </div>
  )
}
