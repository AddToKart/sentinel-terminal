import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { DiffEditor } from '@monaco-editor/react'
import {
  Code2,
  Cpu,
  GitCommit,
  GitMerge,
  History,
  LoaderCircle,
  Maximize2,
  MemoryStick,
  Minimize2,
  Search,
  Sparkles,
  TerminalSquare,
  Trash2,
  X
} from 'lucide-react'

import type { SessionCommandEntry, SessionSummary } from '@shared/types'

interface SessionTileProps {
  session: SessionSummary
  historyEntries: SessionCommandEntry[]
  modifiedPaths: string[]
  onClose: (sessionId: string) => Promise<void>
  onToggleMaximize: (sessionId: string) => void
  mergeWorktree: () => Promise<void>
  commitWorktree: (message: string) => Promise<void>
  discardWorktree: () => Promise<void>
  isMaximized: boolean
  fitNonce: number
}

function statusColor(status: SessionSummary['status']): string {
  if (status === 'ready') return 'bg-emerald-400'
  if (status === 'starting') return 'bg-amber-400 animate-pulse'
  if (status === 'closing') return 'bg-sky-400 animate-pulse'
  if (status === 'error') return 'bg-rose-400'
  return 'bg-white/20'
}

function cleanupLabel(session: SessionSummary): string {
  if (session.status === 'closing') return 'closing'
  if (session.cleanupState === 'removed') return 'cleaned'
  if (session.cleanupState === 'preserved') return 'preserved'
  if (session.cleanupState === 'failed') return 'cleanup failed'
  return session.status
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function SessionTile({
  session,
  historyEntries,
  modifiedPaths,
  onClose,
  onToggleMaximize,
  mergeWorktree,
  commitWorktree,
  discardWorktree,
  isMaximized,
  fitNonce
}: SessionTileProps): JSX.Element {
  const terminalHostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const hasWrittenExitRef = useRef(false)

  const [viewMode, setViewMode] = useState<'terminal' | 'history' | 'review'>('terminal')
  const [historyQuery, setHistoryQuery] = useState('')
  const [opLoading, setOpLoading] = useState<string | null>(null)
  const [reviewFile, setReviewFile] = useState<string>(modifiedPaths[0] || '')
  const [originalContent, setOriginalContent] = useState('')
  const [modifiedContent, setModifiedContent] = useState('')

  // Terminal initialization
  useEffect(() => {
    if (!terminalHostRef.current) return

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 6000,
      theme: { background: '#060a0f', black: '#060a0f' }
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(terminalHostRef.current)
    terminal.writeln(`\x1b[38;2;140;245;221m${session.label.toUpperCase()}\x1b[0m`)
    terminal.writeln(`\x1b[38;2;143;165;184mBranch:\x1b[0m ${session.branchName}`)
    terminal.writeln(`\x1b[38;2;143;165;184mPID:\x1b[0m ${session.pid ?? '--'}`)
    terminal.writeln('')

    const outputCleanup = window.sentinel.onSessionOutput((ev) => {
      if (ev.sessionId === session.id) terminal.write(ev.data)
    })

    const inputDisposable = terminal.onData((data) => {
      void window.sentinel.sendInput(session.id, data)
    })

    const observer = new ResizeObserver(() => {
      if (terminalHostRef.current?.offsetParent) {
        fitAddon.fit()
        void window.sentinel.resizeSession(session.id, terminal.cols, terminal.rows)
      }
    })
    observer.observe(terminalHostRef.current)

    requestAnimationFrame(() => {
      fitAddon.fit()
      terminal.focus()
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    return () => {
      observer.disconnect()
      outputCleanup()
      inputDisposable.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [session.id, session.branchName, session.label, session.pid])

  // Re-fit on nonce/mode change
  useEffect(() => {
    if (viewMode !== 'terminal' || !terminalRef.current || !fitAddonRef.current) return
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit()
      terminalRef.current?.focus()
      void window.sentinel.resizeSession(session.id, terminalRef.current?.cols ?? 0, terminalRef.current?.rows ?? 0)
    })
  }, [session.id, fitNonce, viewMode])

  // Session exit message
  useEffect(() => {
    if (session.status !== 'closed') { hasWrittenExitRef.current = false; return }
    if (!terminalRef.current || hasWrittenExitRef.current) return
    terminalRef.current.writeln(`\n\x1b[38;2;255;170;170mSession exited (code ${session.exitCode ?? 0} · ${cleanupLabel(session)})\x1b[0m`)
    if (session.error) terminalRef.current.writeln(`\x1b[38;2;143;165;184m${session.error}\x1b[0m`)
    hasWrittenExitRef.current = true
  }, [session])

  // Diff viewer content
  useEffect(() => {
    if (viewMode !== 'review' || !reviewFile) return
    let active = true
    async function load() {
      try {
        const sep = session.projectRoot.includes('/') ? '/' : '\\'
        const root = await window.sentinel.readFile(`${session.projectRoot}${sep}${reviewFile}`)
        const wt = await window.sentinel.readFile(`${session.worktreePath}${sep}${reviewFile}`)
        if (!active) return
        setOriginalContent(root)
        setModifiedContent(wt)
      } catch {
        if (!active) return
        setOriginalContent('// Unable to load')
        setModifiedContent('// Unable to load')
      }
    }
    load()
    return () => { active = false }
  }, [viewMode, reviewFile, session.projectRoot, session.worktreePath])

  useEffect(() => {
    if (modifiedPaths.length > 0 && !modifiedPaths.includes(reviewFile)) {
      setReviewFile(modifiedPaths[0])
    }
  }, [modifiedPaths])

  async function handleOp(op: 'merge' | 'commit' | 'discard') {
    if (opLoading) return
    setOpLoading(op)
    try {
      if (op === 'merge') await mergeWorktree()
      if (op === 'commit') {
        const msg = prompt('Commit message:', 'Agent update') || 'Update'
        await commitWorktree(msg)
      }
      if (op === 'discard') {
        if (confirm('Discard all uncommitted changes in this worktree?')) await discardWorktree()
      }
    } catch (e: any) {
      terminalRef.current?.writeln(`\n\x1b[38;2;255;170;170mOp failed: ${e.message}\x1b[0m\n`)
    } finally {
      setOpLoading(null)
    }
  }

  const isClosing = session.status === 'closing' || session.status === 'closed'
  const filteredHistory = historyQuery.trim()
    ? historyEntries.filter((e) => e.command.toLowerCase().includes(historyQuery.toLowerCase()))
    : historyEntries

  return (
    <article
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#060a0f] rounded-none border border-white/10"
      onMouseDown={() => { if (viewMode === 'terminal') terminalRef.current?.focus() }}
    >
      {/* ── Permanent utility strip (20px) ─────────────────────── */}
      <div className="shrink-0 flex items-center justify-between border-b border-white/10 bg-black/40 px-2 h-[20px]">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${statusColor(session.status)}`} />
          <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/80">{session.label}</span>
          {modifiedPaths.length > 0 && (
            <span className="text-[9px] text-amber-400/80 tracking-widest">{modifiedPaths.length} changes</span>
          )}
        </div>
        <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {/* View toggles */}
          <button className={`px-1.5 py-0.5 text-[9px] uppercase tracking-widest transition ${viewMode === 'terminal' ? 'text-white' : 'text-white/30 hover:text-white/70'}`} onClick={() => setViewMode('terminal')} title="Terminal"><TerminalSquare className="h-2.5 w-2.5" /></button>
          <button className={`px-1.5 py-0.5 text-[9px] uppercase tracking-widest transition ${viewMode === 'review' ? 'text-emerald-400' : 'text-white/30 hover:text-white/70'}`} onClick={() => setViewMode('review')} title="Diff"><Code2 className="h-2.5 w-2.5" /></button>
          <button className={`px-1.5 py-0.5 text-[9px] uppercase tracking-widest transition ${viewMode === 'history' ? 'text-sentinel-accent' : 'text-white/30 hover:text-white/70'}`} onClick={() => setViewMode('history')} title="History"><History className="h-2.5 w-2.5" /></button>
          <div className="mx-1 h-3 w-px bg-white/10" />
          {/* Git ops */}
          <button className="px-1 text-white/30 hover:text-emerald-300 transition disabled:opacity-20" disabled={isClosing || opLoading !== null || modifiedPaths.length === 0} onClick={() => handleOp('commit')} title="Commit"><GitCommit className="h-2.5 w-2.5" /></button>
          <button className="px-1 text-white/30 hover:text-rose-300 transition disabled:opacity-20" disabled={isClosing || opLoading !== null || modifiedPaths.length === 0} onClick={() => handleOp('discard')} title="Discard"><Trash2 className="h-2.5 w-2.5" /></button>
          <button className="px-1 text-white/30 hover:text-sentinel-glow transition disabled:opacity-20" disabled={isClosing || opLoading !== null} onClick={() => handleOp('merge')} title="Merge to Main"><GitMerge className="h-2.5 w-2.5" /></button>
          <div className="mx-1 h-3 w-px bg-white/10" />
          <button className="px-1 text-white/30 hover:text-white transition" onClick={() => onToggleMaximize(session.id)} title={isMaximized ? 'Restore' : 'Maximize'}>
            {isMaximized ? <Minimize2 className="h-2.5 w-2.5" /> : <Maximize2 className="h-2.5 w-2.5" />}
          </button>
          <button className="px-1 text-white/30 hover:text-rose-300 transition disabled:opacity-20" disabled={session.status === 'closing'} onClick={() => void onClose(session.id)} title="Close">
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      </div>

      {/* ── Content area ─────────────────────────────────────────── */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {/* Terminal */}
        <div className={`absolute inset-0 ${viewMode === 'terminal' ? 'z-10' : 'z-0 pointer-events-none'}`}>
          <div className="terminal-host h-full w-full overflow-hidden" ref={terminalHostRef} />
        </div>

        {/* Review / Diff */}
        <div className={`absolute inset-0 flex flex-col ${viewMode === 'review' ? 'z-10' : 'z-0 pointer-events-none opacity-0'}`}>
          <div className="shrink-0 bg-black/20 px-2 py-1 border-b border-white/10">
            <select
              className="w-full bg-black/60 border border-white/10 text-[11px] text-sentinel-mist p-0.5 outline-none"
              value={reviewFile}
              onChange={(e) => setReviewFile(e.target.value)}
            >
              {modifiedPaths.length === 0 && <option value="">No modified files</option>}
              {modifiedPaths.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="flex-1 bg-[#1e1e1e] min-h-0">
            {reviewFile ? (
              <DiffEditor
                height="100%"
                language="typescript"
                theme="vs-dark"
                original={originalContent}
                modified={modifiedContent}
                options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12 }}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-sentinel-mist">
                Make edits in the terminal to see diff here.
              </div>
            )}
          </div>
        </div>

        {/* History */}
        <div className={`absolute inset-0 flex flex-col ${viewMode === 'history' ? 'z-10' : 'z-0 pointer-events-none opacity-0'}`}>
          <div className="shrink-0 bg-black/20 p-2 border-b border-white/10">
            <label className="flex items-center gap-2 border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-sentinel-mist">
              <Search className="h-3 w-3 text-sentinel-accent" />
              <input
                className="min-w-0 flex-1 bg-transparent text-white outline-none text-[11px]"
                onChange={(e) => setHistoryQuery(e.target.value)}
                placeholder="Filter commands..."
                value={historyQuery}
              />
            </label>
          </div>
          <div className="flex-1 min-h-0 overflow-auto p-1.5 space-y-0.5">
            {filteredHistory.map((entry) => (
              <div key={entry.id} className="flex gap-2 border border-white/10 bg-white/[0.02] px-2 py-1 text-[10px]">
                <span className="text-sentinel-mist/50 shrink-0">{formatTime(entry.timestamp)}</span>
                <span className="font-mono text-white break-all">{entry.command}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Permanent Telemetry Ribbon (18px) ───────────────────── */}
      <div className="shrink-0 flex items-center justify-between border-t border-white/[0.06] bg-black/60 px-2 h-[18px]">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-[9px] font-mono text-sentinel-mist/70">
            <Cpu className="h-2.5 w-2.5 text-sentinel-ice/60" />
            {session.metrics.cpuPercent.toFixed(1)}%
          </span>
          <span className="flex items-center gap-1 text-[9px] font-mono text-sentinel-mist/70">
            <MemoryStick className="h-2.5 w-2.5 text-sentinel-accent/60" />
            {session.metrics.memoryMb.toFixed(0)} MB
          </span>
        </div>
        <div className="flex items-center gap-3 text-[9px] font-mono text-sentinel-mist/40">
          {session.metrics.processCount > 0 && <span>{session.metrics.processCount} proc</span>}
          {opLoading && (
            <span className="flex items-center gap-1 text-amber-400/70">
              <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
              {opLoading}…
            </span>
          )}
          {session.status !== 'ready' && (
            <span className="flex items-center gap-1 text-sentinel-mist/50">
              <Sparkles className="h-2.5 w-2.5" />
              {cleanupLabel(session)}
            </span>
          )}
        </div>
      </div>
    </article>
  )
}
