import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import {
  Cpu,
  History,
  Layers3,
  LoaderCircle,
  Maximize2,
  MemoryStick,
  Minimize2,
  Search,
  Sparkles,
  TerminalSquare,
  X,
  GitMerge
} from 'lucide-react'

import type { SessionCommandEntry, SessionSummary } from '@shared/types'

interface SessionTileProps {
  session: SessionSummary
  historyEntries: SessionCommandEntry[]
  onClose: (sessionId: string) => Promise<void>
  onToggleMaximize: (sessionId: string) => void
  mergeWorktree: () => Promise<void>
  isMaximized: boolean
  fitNonce: number
}

function statusClasses(status: SessionSummary['status']): string {
  if (status === 'ready') return 'border-emerald-400/30 bg-emerald-400/12 text-emerald-100'
  if (status === 'closing') return 'border-sky-400/30 bg-sky-400/12 text-sky-100'
  if (status === 'starting') return 'border-amber-400/30 bg-amber-400/12 text-amber-100'
  if (status === 'error') return 'border-rose-400/30 bg-rose-400/12 text-rose-100'
  return 'border-white/10 bg-white/[0.04] text-sentinel-mist'
}

function cleanupLabel(session: SessionSummary): string {
  if (session.status === 'closing') return 'closing'
  if (session.cleanupState === 'removed') return 'cleaned up'
  if (session.cleanupState === 'preserved') return 'worktree preserved'
  if (session.cleanupState === 'failed') return 'cleanup failed'
  return session.status
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function SessionTile({
  session,
  historyEntries,
  onClose,
  onToggleMaximize,
  mergeWorktree,
  isMaximized,
  fitNonce
}: SessionTileProps): JSX.Element {
  const terminalHostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const hasWrittenExitMessageRef = useRef(false)
  const [viewMode, setViewMode] = useState<'terminal' | 'history'>('terminal')
  const [historyQuery, setHistoryQuery] = useState('')
  const [merging, setMerging] = useState(false)

  const filteredHistory = historyQuery.trim()
    ? historyEntries.filter((entry) =>
        entry.command.toLowerCase().includes(historyQuery.trim().toLowerCase())
      )
    : historyEntries

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
      theme: {
        background: '#081018',
        foreground: '#eaf2fb',
        cursor: '#8cf5dd',
        cursorAccent: '#081018',
        selectionBackground: '#1f3954',
        black: '#081018',
        red: '#ff7d88',
        green: '#8cf5dd',
        yellow: '#ffce7a',
        blue: '#7db7ff',
        magenta: '#e8b4ff',
        cyan: '#83f0ff',
        white: '#ecf6ff'
      }
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(terminalHostRef.current)
    terminal.writeln(`\x1b[38;2;140;245;221m${session.label.toUpperCase()}\x1b[0m`)
    terminal.writeln(`\x1b[38;2;143;165;184mBranch:\x1b[0m ${session.branchName}`)
    terminal.writeln(`\x1b[38;2;143;165;184mPID:\x1b[0m ${session.pid ?? '--'}`)
    terminal.writeln('')

    const outputCleanup = window.sentinel.onSessionOutput((event) => {
      if (event.sessionId === session.id) terminal.write(event.data)
    })

    const inputDisposable = terminal.onData((data) => {
      void window.sentinel.sendInput(session.id, data)
    })

    const fitTerminal = (): void => {
      fitAddon.fit()
      void window.sentinel.resizeSession(session.id, terminal.cols, terminal.rows)
    }

    const resizeObserver = new ResizeObserver(() => {
      if (terminalHostRef.current?.offsetParent) fitTerminal()
    })

    resizeObserver.observe(terminalHostRef.current)
    requestAnimationFrame(() => {
      fitTerminal()
      terminal.focus()
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    return () => {
      resizeObserver.disconnect()
      outputCleanup()
      inputDisposable.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [session.id, session.branchName, session.label, session.pid])

  useEffect(() => {
    if (viewMode !== 'terminal' || !terminalRef.current || !fitAddonRef.current) return
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit()
      terminalRef.current?.focus()
      void window.sentinel.resizeSession(session.id, terminalRef.current?.cols || 0, terminalRef.current?.rows || 0)
    })
  }, [session.id, session.status, fitNonce, viewMode])

  useEffect(() => {
    if (session.status !== 'closed') {
      hasWrittenExitMessageRef.current = false
      return
    }
    if (!terminalRef.current || hasWrittenExitMessageRef.current) return

    terminalRef.current.writeln('')
    terminalRef.current.writeln(
      `\x1b[38;2;255;170;170mSession exited with code ${session.exitCode ?? 0} (${cleanupLabel(session)})\x1b[0m`
    )
    if (session.error) terminalRef.current.writeln(`\x1b[38;2;143;165;184m${session.error}\x1b[0m`)
    hasWrittenExitMessageRef.current = true
  }, [session])

  async function handleMerge() {
    try {
      setMerging(true)
      await mergeWorktree()
      terminalRef.current?.writeln(`\n\x1b[38;2;140;245;221mMerged branch ${session.branchName} to root successfully.\x1b[0m\n`)
    } catch (e: any) {
      terminalRef.current?.writeln(`\n\x1b[38;2;255;170;170mFailed to merge: ${e.message}\x1b[0m\n`)
    } finally {
      setMerging(false)
    }
  }

  return (
    <article
      className="panel group relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#081018]"
      onMouseDown={() => {
        if (viewMode === 'terminal') terminalRef.current?.focus()
      }}
    >
      {/* 20px Ultra-Slim Utility Strip (Always visible unless hovered) */}
      <div className="pointer-events-none absolute right-0 top-0 z-10 flex h-5 items-center gap-2 bg-black/60 px-2 text-[10px] uppercase tracking-wider text-white opacity-100 transition-opacity duration-200 group-hover:opacity-0">
        <span className="font-semibold text-sentinel-glow">{session.label}</span>
        <div className="pointer-events-auto flex items-center">
          <button
            className="text-white/50 hover:text-white"
            onClick={(e) => {
              e.stopPropagation()
              onToggleMaximize(session.id)
            }}
          >
            {isMaximized ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {/* Hover-Activated Overlay for Metadata & Actions */}
      <div className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#081018]/95 px-3 py-1.5 opacity-0 backdrop-blur transition-opacity duration-200 group-hover:opacity-100">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="inline-flex items-center border border-white/15 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-sentinel-ink">
            {session.label}
          </div>
          <div
            className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.2em] ${statusClasses(session.status)}`}
          >
            {session.status === 'starting' || session.status === 'closing' ? (
              <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <Sparkles className="h-2.5 w-2.5" />
            )}
            {cleanupLabel(session)}
          </div>
          <div className="hidden items-center border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[9px] font-mono text-sentinel-mist lg:inline-flex">
            PID {session.pid ?? '--'}
          </div>
          <div className="truncate text-xs text-sentinel-mist" title={session.worktreePath}>
            {session.worktreePath.split(/[\/\\]/).pop()}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-1">
          <button
            className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[10px] uppercase tracking-widest transition ${
              viewMode === 'terminal' ? 'border-sentinel-accent/40 bg-sentinel-accent/12 text-white' : 'border-white/10 text-sentinel-mist hover:text-white bg-white/[0.03]'
            }`}
            onClick={() => setViewMode('terminal')}
            type="button"
          >
            <TerminalSquare className="h-3 w-3" /> Term
          </button>
          <button
            className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[10px] uppercase tracking-widest transition ${
              viewMode === 'history' ? 'border-sentinel-accent/40 bg-sentinel-accent/12 text-white' : 'border-white/10 text-sentinel-mist hover:text-white bg-white/[0.03]'
            }`}
            onClick={() => setViewMode('history')}
            type="button"
          >
            <History className="h-3 w-3" /> Hist
          </button>

          <div className="mx-1 h-4 w-px bg-white/10" />

          <button
            className="inline-flex items-center gap-1 border border-sentinel-accent/30 bg-sentinel-accent/10 px-2 py-1 text-[10px] font-semibold text-sentinel-glow transition hover:bg-sentinel-accent/20 disabled:opacity-50"
            onClick={handleMerge}
            disabled={merging || session.status === 'closing' || session.status === 'closed'}
            type="button"
          >
            <GitMerge className={`h-3 w-3 ${merging ? 'animate-pulse' : ''}`} />
            Merge to Main
          </button>
          <button
            className="inline-flex items-center justify-center border border-white/10 bg-white/[0.04] p-1 text-sentinel-mist transition hover:border-sentinel-accent/40 hover:bg-sentinel-accent/10 hover:text-white"
            onClick={() => onToggleMaximize(session.id)}
            title={isMaximized ? 'Exit Zen Mode' : 'Zen Mode'}
            type="button"
          >
            {isMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button
            className="inline-flex items-center justify-center border border-white/10 bg-white/[0.04] p-1 text-sentinel-mist transition hover:border-rose-400/40 hover:bg-rose-400/10 hover:text-white disabled:cursor-wait disabled:opacity-60"
            disabled={session.status === 'closing'}
            onClick={() => void onClose(session.id)}
            title="Close session"
            type="button"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <div className={`h-full min-h-0 ${viewMode === 'terminal' ? 'block' : 'hidden'}`}>
          <div className="terminal-host h-full min-h-0 w-full overflow-hidden" ref={terminalHostRef} />
        </div>

        <div className={`h-full min-h-0 ${viewMode === 'history' ? 'block' : 'hidden'}`}>
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            <div className="border-b border-white/10 bg-black/20 p-2">
              <label className="flex items-center gap-2 border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-sentinel-mist">
                <Search className="h-3.5 w-3.5 text-sentinel-accent" />
                <input
                  className="min-w-0 flex-1 border-0 bg-transparent py-0.5 text-white outline-none placeholder:text-sentinel-mist"
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  placeholder="Search commands in this session"
                  type="search"
                  value={historyQuery}
                />
              </label>
            </div>
            <div className="min-h-0 overflow-auto p-2">
              {filteredHistory.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-sentinel-mist">
                  {historyEntries.length === 0 ? 'No commands yet.' : 'No commands match.'}
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredHistory.map((entry) => (
                    <div key={entry.id} className="flex min-w-0 items-start gap-2 border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px]">
                      <div className="pt-0.5 font-mono text-sentinel-mist/70">{formatTime(entry.timestamp)}</div>
                      <div className="font-mono text-white">{entry.command}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </article>
  )
}
