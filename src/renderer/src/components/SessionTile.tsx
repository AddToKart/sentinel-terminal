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
  X
} from 'lucide-react'

import type { SessionCommandEntry, SessionSummary } from '@shared/types'

interface SessionTileProps {
  session: SessionSummary
  historyEntries: SessionCommandEntry[]
  onClose: (sessionId: string) => Promise<void>
  onToggleMaximize: (sessionId: string) => void
  isMaximized: boolean
  fitNonce: number
}

function statusClasses(status: SessionSummary['status']): string {
  if (status === 'ready') {
    return 'border-emerald-400/30 bg-emerald-400/12 text-emerald-100'
  }

  if (status === 'closing') {
    return 'border-sky-400/30 bg-sky-400/12 text-sky-100'
  }

  if (status === 'starting') {
    return 'border-amber-400/30 bg-amber-400/12 text-amber-100'
  }

  if (status === 'error') {
    return 'border-rose-400/30 bg-rose-400/12 text-rose-100'
  }

  return 'border-white/10 bg-white/[0.04] text-sentinel-mist'
}

function cleanupLabel(session: SessionSummary): string {
  if (session.status === 'closing') {
    return 'closing'
  }

  if (session.cleanupState === 'removed') {
    return 'cleaned up'
  }

  if (session.cleanupState === 'preserved') {
    return 'worktree preserved'
  }

  if (session.cleanupState === 'failed') {
    return 'cleanup failed'
  }

  return session.status
}

function metricFill(value: number, max: number): string {
  return `${Math.max(0, Math.min(100, (value / max) * 100))}%`
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
  isMaximized,
  fitNonce
}: SessionTileProps): JSX.Element {
  const terminalHostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const hasWrittenExitMessageRef = useRef(false)
  const [viewMode, setViewMode] = useState<'terminal' | 'history'>('terminal')
  const [historyQuery, setHistoryQuery] = useState('')

  const filteredHistory = historyQuery.trim()
    ? historyEntries.filter((entry) =>
        entry.command.toLowerCase().includes(historyQuery.trim().toLowerCase())
      )
    : historyEntries

  useEffect(() => {
    if (!terminalHostRef.current) {
      return
    }

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
        white: '#ecf6ff',
        brightBlack: '#547084',
        brightRed: '#ff98a0',
        brightGreen: '#a7ffef',
        brightYellow: '#ffe39d',
        brightBlue: '#a0caff',
        brightMagenta: '#f0ccff',
        brightCyan: '#a9fbff',
        brightWhite: '#ffffff'
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
      if (event.sessionId === session.id) {
        terminal.write(event.data)
      }
    })

    const inputDisposable = terminal.onData((data) => {
      void window.sentinel.sendInput(session.id, data)
    })

    const fitTerminal = (): void => {
      fitAddon.fit()
      void window.sentinel.resizeSession(session.id, terminal.cols, terminal.rows)
    }

    const resizeObserver = new ResizeObserver(() => {
      if (terminalHostRef.current?.offsetParent) {
        fitTerminal()
      }
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
    if (viewMode !== 'terminal' || !terminalRef.current || !fitAddonRef.current) {
      return
    }

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

    if (!terminalRef.current || hasWrittenExitMessageRef.current) {
      return
    }

    terminalRef.current.writeln('')
    terminalRef.current.writeln(
      `\x1b[38;2;255;170;170mSession exited with code ${session.exitCode ?? 0} (${cleanupLabel(session)})\x1b[0m`
    )

    if (session.error) {
      terminalRef.current.writeln(`\x1b[38;2;143;165;184m${session.error}\x1b[0m`)
    }

    hasWrittenExitMessageRef.current = true
  }, [session])

  return (
    <article
      className="panel group flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      onMouseDown={() => {
        if (viewMode === 'terminal') {
          terminalRef.current?.focus()
        }
      }}
    >
      <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-white/10 bg-white/[0.03] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="inline-flex items-center border border-white/15 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.28em] text-sentinel-ink">
            {session.label.toUpperCase()}
          </div>
          <div
            className={`inline-flex items-center gap-2 border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] ${statusClasses(session.status)}`}
          >
            {session.status === 'starting' || session.status === 'closing' ? (
              <LoaderCircle className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {cleanupLabel(session)}
          </div>
          <div className="hidden items-center border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] font-mono text-sentinel-mist lg:inline-flex">
            PID {session.pid ?? '--'}
          </div>
        </div>

        <div className="flex min-w-0 items-center justify-center gap-1">
          <button
            className={`inline-flex items-center gap-2 border px-2.5 py-1 text-[11px] uppercase tracking-[0.22em] transition ${
              viewMode === 'terminal'
                ? 'border-sentinel-accent/40 bg-sentinel-accent/12 text-white'
                : 'border-white/10 bg-white/[0.03] text-sentinel-mist hover:text-white'
            }`}
            onClick={() => {
              setViewMode('terminal')
            }}
            type="button"
          >
            <TerminalSquare className="h-3.5 w-3.5" />
            Terminal
          </button>
          <button
            className={`inline-flex items-center gap-2 border px-2.5 py-1 text-[11px] uppercase tracking-[0.22em] transition ${
              viewMode === 'history'
                ? 'border-sentinel-accent/40 bg-sentinel-accent/12 text-white'
                : 'border-white/10 bg-white/[0.03] text-sentinel-mist hover:text-white'
            }`}
            onClick={() => {
              setViewMode('history')
            }}
            type="button"
          >
            <History className="h-3.5 w-3.5" />
            History
          </button>
        </div>

        <div className="flex items-center justify-end gap-1">
          <button
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-white/10 bg-white/[0.04] text-sentinel-mist transition hover:border-sentinel-accent/40 hover:bg-sentinel-accent/10 hover:text-white"
            onClick={() => {
              onToggleMaximize(session.id)
            }}
            title={isMaximized ? 'Exit Zen Mode' : 'Zen Mode'}
            type="button"
          >
            {isMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>

          <button
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-white/10 bg-white/[0.04] text-sentinel-mist transition hover:border-rose-400/40 hover:bg-rose-400/10 hover:text-white disabled:cursor-wait disabled:opacity-60"
            disabled={session.status === 'closing'}
            onClick={() => {
              void onClose(session.id)
            }}
            title="Close session"
            type="button"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="relative flex-1 overflow-hidden bg-[#081018]">
        {viewMode === 'terminal' && (session.status === 'starting' || session.status === 'closing') && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-amber-300/15 bg-amber-300/8 px-4 py-2 text-xs text-amber-100">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {session.status === 'starting'
              ? 'Spawning PowerShell with ConPTY and waiting for first output...'
              : 'Stopping the shell, terminating tracked processes, and removing the worktree...'}
          </div>
        )}

        <div
          className={`h-full min-h-0 ${viewMode === 'terminal' ? 'block' : 'hidden'}`}
        >
          <div
            className={`terminal-host h-full min-h-0 w-full overflow-hidden ${session.status === 'starting' || session.status === 'closing' ? 'pt-9' : ''}`}
            ref={terminalHostRef}
          />
        </div>

        <div className={`h-full min-h-0 ${viewMode === 'history' ? 'block' : 'hidden'}`}>
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            <div className="border-b border-white/10 bg-black/20 p-3">
              <label className="flex items-center gap-2 border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-sentinel-mist">
                <Search className="h-4 w-4 text-sentinel-accent" />
                <input
                  className="min-w-0 flex-1 border-0 bg-transparent text-sm text-white outline-none placeholder:text-sentinel-mist"
                  onChange={(event) => {
                    setHistoryQuery(event.target.value)
                  }}
                  placeholder="Search commands in this session"
                  type="search"
                  value={historyQuery}
                />
              </label>
            </div>

            <div className="min-h-0 overflow-auto p-3">
              {filteredHistory.length === 0 ? (
                <div className="flex h-full items-center justify-center border border-dashed border-white/10 bg-white/[0.03] px-4 text-sm text-sentinel-mist">
                  {historyEntries.length === 0
                    ? 'No commands recorded yet for this agent.'
                    : 'No commands match the current search.'}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredHistory.map((entry) => (
                    <div
                      key={entry.id}
                      className="grid min-w-0 grid-cols-[80px_88px_minmax(0,1fr)] items-start gap-3 border border-white/10 bg-white/[0.03] px-3 py-2 text-xs"
                    >
                      <div className="pt-1 font-mono text-sentinel-mist">{formatTime(entry.timestamp)}</div>
                      <div className="inline-flex items-center justify-center border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-sentinel-mist">
                        {entry.source}
                      </div>
                      <div className="min-w-0 font-mono text-white">{entry.command}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <footer className="grid gap-3 border-t border-white/10 bg-white/[0.02] px-3 py-3 text-xs text-sentinel-mist sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px]">
        <div className="space-y-2 border border-white/10 bg-black/20 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2 font-medium uppercase tracking-[0.2em] text-sentinel-mist">
              <Cpu className="h-3.5 w-3.5 text-sentinel-ice" />
              CPU
            </div>
            <span className="font-mono text-white">{session.metrics.cpuPercent.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden bg-white/10">
            <div
              className="h-full bg-sentinel-ice"
              style={{ width: metricFill(session.metrics.cpuPercent, 100) }}
            />
          </div>
        </div>

        <div className="space-y-2 border border-white/10 bg-black/20 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2 font-medium uppercase tracking-[0.2em] text-sentinel-mist">
              <MemoryStick className="h-3.5 w-3.5 text-sentinel-accent" />
              Memory
            </div>
            <span className="font-mono text-white">{session.metrics.memoryMb.toFixed(1)} MB</span>
          </div>
          <div className="h-1.5 overflow-hidden bg-white/10">
            <div
              className="h-full bg-sentinel-accent"
              style={{ width: metricFill(session.metrics.memoryMb, 4096) }}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border border-white/10 bg-black/20 px-3 py-2">
          <div className="inline-flex items-center gap-2 font-medium uppercase tracking-[0.2em] text-sentinel-mist">
            <Layers3 className="h-3.5 w-3.5 text-white" />
            Processes
          </div>
          <span className="font-mono text-white">{session.metrics.processCount}</span>
        </div>
      </footer>
    </article>
  )
}
