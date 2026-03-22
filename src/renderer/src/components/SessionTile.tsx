import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { DiffEditor } from '@monaco-editor/react'
import {
  Cpu,
  History,
  LoaderCircle,
  Maximize2,
  MemoryStick,
  Minimize2,
  Search,
  Sparkles,
  TerminalSquare,
  X,
  GitMerge,
  GitCommit,
  Trash2,
  Code2
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
  const hasWrittenExitMessageRef = useRef(false)
  
  const [viewMode, setViewMode] = useState<'terminal' | 'history' | 'review'>('terminal')
  const [historyQuery, setHistoryQuery] = useState('')
  const [opLoading, setOpLoading] = useState<string | null>(null)
  const [reviewFile, setReviewFile] = useState<string>(modifiedPaths[0] || '')
  
  const [originalContent, setOriginalContent] = useState('')
  const [modifiedContent, setModifiedContent] = useState('')

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
      theme: { background: '#081018' }
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
    terminalRef.current.writeln(`\n\x1b[38;2;255;170;170mSession exited with code ${session.exitCode ?? 0} (${cleanupLabel(session)})\x1b[0m`)
    if (session.error) terminalRef.current.writeln(`\x1b[38;2;143;165;184m${session.error}\x1b[0m`)
    hasWrittenExitMessageRef.current = true
  }, [session])

  useEffect(() => {
    if (viewMode !== 'review' || !reviewFile) return
    let active = true
    async function fetchDiffs() {
      try {
        const rootContent = await window.sentinel.readFile(`${session.projectRoot}/${reviewFile}`)
        const worktreeContent = await window.sentinel.readFile(`${session.worktreePath}/${reviewFile}`)
        if (active) {
          setOriginalContent(rootContent)
          setModifiedContent(worktreeContent)
        }
      } catch (e) {
        if (active) {
          setOriginalContent('// Unable to load file')
          setModifiedContent('// Unable to load file')
        }
      }
    }
    fetchDiffs()
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
        const msg = prompt('Commit message:', 'Auto-commit from Sentinel') || 'Update'
        await commitWorktree(msg)
      }
      if (op === 'discard') {
        if (confirm('Discard all uncommitted changes?')) await discardWorktree()
      }
    } catch (e: any) {
      terminalRef.current?.writeln(`\n\x1b[38;2;255;170;170mOperation failed: ${e.message}\x1b[0m\n`)
    } finally {
      setOpLoading(null)
    }
  }

  const isClosing = session.status === 'closing' || session.status === 'closed'

  return (
    <article
      className="panel group relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#081018] rounded-none border border-white/10"
      onMouseDown={() => {
        if (viewMode === 'terminal') terminalRef.current?.focus()
      }}
    >
      <div className="pointer-events-none absolute right-0 top-0 z-10 flex h-5 items-center gap-2 bg-black/60 px-2 text-[10px] uppercase tracking-wider text-white opacity-100 transition-opacity duration-200 group-hover:opacity-0">
        <span className="font-semibold text-sentinel-glow">{session.label}</span>
        <div className="pointer-events-auto flex items-center">
          <button className="text-white/50 hover:text-white" onClick={(e) => { e.stopPropagation(); onToggleMaximize(session.id) }}>
            {isMaximized ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          </button>
        </div>
      </div>

      <div className="absolute inset-x-0 top-0 z-20 flex flex-col border-b border-white/10 bg-[#081018]/95 opacity-0 backdrop-blur transition-opacity duration-200 group-hover:opacity-100">
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="inline-flex items-center border border-white/15 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-sentinel-ink">
              {session.label}
            </div>
            <div className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.2em] ${statusClasses(session.status)}`}>
              {session.status === 'starting' || session.status === 'closing' ? <LoaderCircle className="h-2.5 w-2.5 animate-spin" /> : <Sparkles className="h-2.5 w-2.5" />}
              {cleanupLabel(session)}
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-1">
            <button className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[10px] uppercase tracking-widest transition ${viewMode === 'terminal' ? 'border-sentinel-accent/40 bg-sentinel-accent/12 text-white' : 'border-white/10 text-sentinel-mist hover:text-white bg-white/[0.03]'}`} onClick={() => setViewMode('terminal')}>
              <TerminalSquare className="h-3 w-3" /> Term
            </button>
            <button className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[10px] uppercase tracking-widest transition ${viewMode === 'review' ? 'border-emerald-400/40 bg-emerald-400/12 text-white' : 'border-white/10 text-sentinel-mist hover:text-white bg-white/[0.03]'}`} onClick={() => setViewMode('review')}>
              <Code2 className="h-3 w-3" /> Diff
            </button>
            <button className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[10px] uppercase tracking-widest transition ${viewMode === 'history' ? 'border-sentinel-accent/40 bg-sentinel-accent/12 text-white' : 'border-white/10 text-sentinel-mist hover:text-white bg-white/[0.03]'}`} onClick={() => setViewMode('history')}>
              <History className="h-3 w-3" /> Hist
            </button>
            <div className="mx-1 h-4 w-px bg-white/10" />
            <button className="inline-flex items-center justify-center border border-white/10 bg-white/[0.04] p-1 text-sentinel-mist transition hover:bg-sentinel-accent/10 hover:text-white" onClick={() => onToggleMaximize(session.id)} title={isMaximized ? 'Exit Zen Mode' : 'Zen Mode'}>
              {isMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
            <button className="inline-flex items-center justify-center border border-white/10 bg-rose-500/10 p-1 text-rose-300 transition hover:bg-rose-500/30 hover:text-white disabled:opacity-60" disabled={session.status === 'closing'} onClick={() => void onClose(session.id)} title="Close session">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        
        {/* Operations Bar */}
        <div className="flex items-center gap-2 bg-black/40 px-3 py-1.5 border-t border-white/5">
          <div className="text-[10px] uppercase text-sentinel-mist font-semibold mr-2 tracking-widest">Ops</div>
          <button className="inline-flex items-center gap-1 border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300 transition disabled:opacity-50" disabled={isClosing || opLoading !== null || modifiedPaths.length === 0} onClick={() => handleOp('commit')}>
            <GitCommit className="h-3 w-3" /> Commit Changes
          </button>
          <button className="inline-flex items-center gap-1 border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 px-2 py-0.5 text-[10px] text-rose-300 transition disabled:opacity-50" disabled={isClosing || opLoading !== null || modifiedPaths.length === 0} onClick={() => handleOp('discard')}>
            <Trash2 className="h-3 w-3" /> Discard Worktree
          </button>
          <button className="inline-flex items-center gap-1 border border-sentinel-accent/30 bg-sentinel-accent/10 hover:bg-sentinel-accent/20 px-2 py-0.5 text-[10px] text-sentinel-glow transition disabled:opacity-50" disabled={isClosing || opLoading !== null} onClick={() => handleOp('merge')}>
            <GitMerge className="h-3 w-3" /> Merge to Main
          </button>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <div className={`h-full min-h-0 ${viewMode === 'terminal' ? 'block' : 'hidden'}`}>
          <div className="terminal-host h-full min-h-0 w-full overflow-hidden" ref={terminalHostRef} />
        </div>

        <div className={`h-full min-h-0 ${viewMode === 'review' ? 'flex flex-col' : 'hidden'}`}>
           <div className="bg-black/20 p-2 border-b border-white/10 shrink-0">
              <select className="w-full bg-black border border-white/10 text-xs text-sentinel-mist p-1 outline-none" value={reviewFile} onChange={(e) => setReviewFile(e.target.value)}>
                 {modifiedPaths.length === 0 && <option value="">No files modified</option>}
                 {modifiedPaths.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
           </div>
           <div className="flex-1 bg-[#1e1e1e]">
             {reviewFile ? (
               <DiffEditor height="100%" language="typescript" theme="vs-dark" original={originalContent} modified={modifiedContent} options={{ readOnly: true, minimap: { enabled: false } }} />
             ) : (
               <div className="flex h-full items-center justify-center text-xs text-sentinel-mist">Make edits in the terminal to view diffs.</div>
             )}
           </div>
        </div>

        <div className={`h-full min-h-0 ${viewMode === 'history' ? 'block' : 'hidden'}`}>
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
             <div className="border-b border-white/10 bg-black/20 p-2">
                 <label className="flex items-center gap-2 border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-sentinel-mist">
                    <Search className="h-3.5 w-3.5 text-sentinel-accent" />
                    <input className="min-w-0 flex-1 border-0 bg-transparent py-0.5 text-white outline-none" onChange={(e) => setHistoryQuery(e.target.value)} placeholder="Search..." value={historyQuery} />
                 </label>
             </div>
             <div className="min-h-0 overflow-auto p-2">
                 {filteredHistory.map((entry) => (
                    <div key={entry.id} className="flex gap-2 border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] mb-1">
                       <span className="text-sentinel-mist/70">{formatTime(entry.timestamp)}</span>
                       <span className="text-white font-mono break-all">{entry.command}</span>
                    </div>
                 ))}
             </div>
          </div>
        </div>
      </div>
      
      {/* Ultra-slim Resource Footer */}
      <div className="shrink-0 flex items-center justify-between border-t border-white/10 bg-[#060a0f] px-2 py-1 select-none">
         <div className="flex gap-4 text-[9px] uppercase tracking-widest text-sentinel-mist">
            <span className="flex items-center gap-1"><Cpu className="h-3 w-3 text-sentinel-ice" /> {session.metrics.cpuPercent.toFixed(1)}%</span>
            <span className="flex items-center gap-1"><MemoryStick className="h-3 w-3 text-sentinel-accent" /> {session.metrics.memoryMb.toFixed(0)} MB</span>
         </div>
         <div className="text-[9px] font-mono text-sentinel-mist/50">
            {session.metrics.processCount} PROC
         </div>
      </div>
    </article>
  )
}
