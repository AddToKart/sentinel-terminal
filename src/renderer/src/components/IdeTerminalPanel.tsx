import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { CheckCheck, LoaderCircle, RefreshCw, RotateCcw, TerminalSquare } from 'lucide-react'

import type { IdeTerminalState } from '@shared/types'
import { createTerminalOptions, installTerminalMaintenance } from '../terminal-config'
import { clearIdeTerminalOutput, subscribeToIdeTerminalOutput } from '../terminal-stream'

interface IdeTerminalPanelProps {
  fitNonce: number
  projectPath?: string
  terminalState: IdeTerminalState
  windowsBuildNumber?: number
}

function createIdleState(projectPath?: string): IdeTerminalState {
  return {
    status: 'idle',
    shell: 'powershell.exe',
    cwd: projectPath,
    modifiedPaths: []
  }
}

function describeState(state: IdeTerminalState): string {
  if (state.status === 'idle') return 'idle'
  if (state.status === 'starting') return 'starting'
  if (state.status === 'closing') return 'closing'
  if (state.status === 'error') return 'shell error'
  if (state.status === 'closed') return 'closed'
  return 'ready'
}

export function IdeTerminalPanel({
  fitNonce,
  projectPath,
  terminalState: externalState,
  windowsBuildNumber
}: IdeTerminalPanelProps): JSX.Element {
  const terminalHostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const writeQueueRef = useRef<string[]>([])
  const writeFrameRef = useRef<number | null>(null)
  const writeInFlightRef = useRef(false)
  const fitFrameRef = useRef<number | null>(null)
  const fitTimerRef = useRef<number | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  const lastGeometryRef = useRef({ width: 0, height: 0, cols: 0, rows: 0 })
  const lastProjectPathRef = useRef<string | undefined>(projectPath)
  const hasWrittenExitRef = useRef(false)

  const [terminalState, setTerminalState] = useState<IdeTerminalState>(() => externalState)
  const [connecting, setConnecting] = useState(false)
  const [operationLoading, setOperationLoading] = useState<'apply' | 'discard' | null>(null)

  function scheduleWriteFlush(): void {
    if (writeFrameRef.current !== null) {
      return
    }

    writeFrameRef.current = requestAnimationFrame(() => {
      writeFrameRef.current = null

      const terminal = terminalRef.current
      if (!terminal || writeInFlightRef.current || writeQueueRef.current.length === 0) {
        return
      }

      const chunk = writeQueueRef.current.join('')
      writeQueueRef.current = []
      writeInFlightRef.current = true

      terminal.write(chunk, () => {
        writeInFlightRef.current = false
        if (writeQueueRef.current.length > 0) {
          scheduleWriteFlush()
        }
      })
    })
  }

  function enqueueOutput(data: string): void {
    if (!data) {
      return
    }

    writeQueueRef.current.push(data)
    scheduleWriteFlush()
  }

  function performTerminalFit(): void {
    const host = terminalHostRef.current
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current

    if (!host || !terminal || !fitAddon) {
      return
    }

    const width = host.clientWidth
    const height = host.clientHeight
    if (width < 8 || height < 8) {
      return
    }

    fitAddon.fit()

    const cols = terminal.cols
    const rows = terminal.rows
    if (cols <= 0 || rows <= 0) {
      return
    }

    const lastGeometry = lastGeometryRef.current
    const hostChanged = lastGeometry.width !== width || lastGeometry.height !== height
    const cellGeometryChanged = lastGeometry.cols !== cols || lastGeometry.rows !== rows

    if (!hostChanged && !cellGeometryChanged) {
      return
    }

    lastGeometryRef.current = { width, height, cols, rows }
    if (cellGeometryChanged) {
      void window.sentinel.resizeIdeTerminal(cols, rows)
    }
  }

  function scheduleTerminalFit(delay = 120): void {
    if (fitTimerRef.current !== null) {
      window.clearTimeout(fitTimerRef.current)
    }

    fitTimerRef.current = window.setTimeout(() => {
      fitTimerRef.current = null

      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current)
      }

      fitFrameRef.current = requestAnimationFrame(() => {
        fitFrameRef.current = null
        performTerminalFit()
      })
    }, delay)
  }

  function scheduleTerminalFocus(): void {
    if (focusFrameRef.current !== null) {
      return
    }

    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null
      terminalRef.current?.focus()
    })
  }

  function configureTerminalDom(terminal: Terminal): void {
    const textarea = terminal.textarea
    if (!textarea) {
      return
    }

    textarea.spellcheck = false
    textarea.autocapitalize = 'off'
    textarea.autocomplete = 'off'
    textarea.autocorrect = false
    textarea.setAttribute('aria-hidden', 'true')
    textarea.style.pointerEvents = 'none'
    textarea.style.position = 'fixed'
    textarea.style.left = '-99999px'
    textarea.style.top = '0'
    textarea.style.width = '1px'
    textarea.style.height = '1px'
    textarea.style.opacity = '0'
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>): void {
    const terminal = terminalRef.current
    if (!terminal || event.deltaY === 0) {
      return
    }

    event.preventDefault()
    const lines = Math.sign(event.deltaY) * Math.max(1, Math.ceil(Math.abs(event.deltaY) / 48))
    terminal.scrollLines(lines)
  }

  async function ensureTerminal(resetOutput = false): Promise<void> {
    if (!projectPath) {
      setTerminalState(createIdleState())
      return
    }

    if (resetOutput) {
      clearIdeTerminalOutput()
      terminalRef.current?.clear()
      lastGeometryRef.current = { width: 0, height: 0, cols: 0, rows: 0 }
      hasWrittenExitRef.current = false
    }

    setConnecting(true)
    try {
      const state = await window.sentinel.ensureIdeTerminal()
      setTerminalState(state)
      requestAnimationFrame(() => {
        scheduleTerminalFit(0)
        scheduleTerminalFocus()
      })
    } finally {
      setConnecting(false)
    }
  }

  useEffect(() => {
    if (!terminalHostRef.current) {
      return
    }

    const terminal = new Terminal(createTerminalOptions(windowsBuildNumber))

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(terminalHostRef.current)
    configureTerminalDom(terminal)
    terminal.writeln('\x1b[38;2;140;245;221mIDE WORKSPACE SHELL\x1b[0m')
    terminal.writeln('\x1b[38;2;143;165;184mIDE mode runs in its own isolated sandbox workspace.\x1b[0m')
    terminal.writeln('')

    const outputCleanup = subscribeToIdeTerminalOutput((data) => {
      enqueueOutput(data)
    })

    const inputDisposable = terminal.onData((data) => {
      void window.sentinel.sendIdeTerminalInput(data)
    })

    const observer = new ResizeObserver(() => {
      scheduleTerminalFit(140)
    })
    observer.observe(terminalHostRef.current)

    const disposeMaintenance = installTerminalMaintenance(terminal, () => true)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    void ensureTerminal()

    return () => {
      observer.disconnect()
      disposeMaintenance()
      outputCleanup()
      inputDisposable.dispose()
      if (writeFrameRef.current !== null) {
        cancelAnimationFrame(writeFrameRef.current)
        writeFrameRef.current = null
      }
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = null
      }
      if (fitTimerRef.current !== null) {
        window.clearTimeout(fitTimerRef.current)
        fitTimerRef.current = null
      }
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current)
        focusFrameRef.current = null
      }
      writeQueueRef.current = []
      writeInFlightRef.current = false
      lastGeometryRef.current = { width: 0, height: 0, cols: 0, rows: 0 }
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [windowsBuildNumber])

  useEffect(() => {
    setTerminalState(externalState)
  }, [externalState])

  useEffect(() => {
    if (lastProjectPathRef.current !== projectPath) {
      lastProjectPathRef.current = projectPath
      void ensureTerminal(true)
    }
  }, [projectPath])

  useEffect(() => {
    scheduleTerminalFit(60)
  }, [fitNonce])

  useEffect(() => {
    if (terminalState.status !== 'closed' && terminalState.status !== 'error') {
      hasWrittenExitRef.current = false
      return
    }

    if (hasWrittenExitRef.current) {
      return
    }

    enqueueOutput(`\r\n\x1b[38;2;255;170;170mIDE terminal ${describeState(terminalState)}.\x1b[0m\r\n`)
    if (terminalState.error) {
      enqueueOutput(`\x1b[38;2;143;165;184m${terminalState.error}\x1b[0m\r\n`)
    }
    hasWrittenExitRef.current = true
  }, [terminalState])

  async function handleWorkspaceOp(op: 'apply' | 'discard'): Promise<void> {
    if (operationLoading) {
      return
    }

    setOperationLoading(op)
    try {
      if (op === 'apply') {
        const result = await window.sentinel.applyIdeWorkspace()
        if (result.conflicts.length > 0) {
          enqueueOutput(`\r\n\x1b[38;2;255;170;170mIDE apply completed with ${result.conflicts.length} conflict(s).\x1b[0m\r\n`)
        } else {
          enqueueOutput(`\r\n\x1b[38;2;140;245;221mApplied ${result.appliedPaths.length} IDE workspace file(s) back to the main project.\x1b[0m\r\n`)
        }
      } else {
        await window.sentinel.discardIdeWorkspaceChanges()
        enqueueOutput('\r\n\x1b[38;2;140;245;221mIDE workspace reset to the main project baseline.\x1b[0m\r\n')
      }
    } catch (error: any) {
      enqueueOutput(`\r\n\x1b[38;2;255;170;170mIDE workspace op failed: ${error.message}\x1b[0m\r\n`)
    } finally {
      setOperationLoading(null)
    }
  }

  if (!projectPath) {
    return (
      <div className="flex h-full items-center justify-center border-t border-white/10 bg-[#060a0f] text-sm text-sentinel-mist">
        Open a project folder to start the IDE terminal.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-t border-white/10 bg-[#060a0f]">
      <div className="flex h-[24px] shrink-0 items-center justify-between border-b border-white/10 bg-black/40 px-2">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare className="h-3 w-3 text-sentinel-accent" />
          <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/80">IDE Workspace</span>
          <span className="truncate text-[10px] text-sentinel-mist/70">{terminalState.workspacePath || terminalState.cwd || projectPath}</span>
        </div>
        <div className="flex items-center gap-2">
          {terminalState.modifiedPaths.length > 0 && (
            <span className="text-[10px] uppercase tracking-[0.2em] text-amber-300/80">
              {terminalState.modifiedPaths.length} changes
            </span>
          )}
          {(connecting || terminalState.status === 'starting') && (
            <LoaderCircle className="h-3 w-3 animate-spin text-amber-300" />
          )}
          <span className="text-[10px] uppercase tracking-[0.2em] text-sentinel-mist/70">
            {describeState(terminalState)}
          </span>
          <button
            className="inline-flex h-5 w-5 items-center justify-center text-sentinel-mist/60 transition hover:text-sentinel-glow disabled:opacity-30"
            disabled={terminalState.modifiedPaths.length === 0 || operationLoading !== null}
            onClick={() => void handleWorkspaceOp('apply')}
            title="Apply IDE workspace to main project"
            type="button"
          >
            <CheckCheck className="h-3 w-3" />
          </button>
          <button
            className="inline-flex h-5 w-5 items-center justify-center text-sentinel-mist/60 transition hover:text-rose-300 disabled:opacity-30"
            disabled={terminalState.modifiedPaths.length === 0 || operationLoading !== null}
            onClick={() => void handleWorkspaceOp('discard')}
            title="Reset IDE workspace"
            type="button"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
          <button
            className="inline-flex h-5 w-5 items-center justify-center text-sentinel-mist/60 transition hover:text-white"
            onClick={() => void ensureTerminal(true)}
            title="Reconnect shell"
            type="button"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="terminal-host h-full min-h-0 w-full overflow-hidden" onMouseDown={() => scheduleTerminalFocus()} onWheel={handleWheel} ref={terminalHostRef} />
    </div>
  )
}
