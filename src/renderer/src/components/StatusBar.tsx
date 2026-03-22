import { Clock3, Cpu, GitBranch, Layers3, MemoryStick, TerminalSquare } from 'lucide-react'

import type { WorkspaceSummary } from '@shared/types'

interface StatusBarProps {
  summary: WorkspaceSummary
  consoleOpen: boolean
  onToggleConsole: () => void
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function StatusBar({ summary, consoleOpen, onToggleConsole }: StatusBarProps): JSX.Element {
  return (
    <footer className="border-t border-white/10 bg-sentinel-ink/75 px-6 py-3 backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-sentinel-mist">
        <div className="flex flex-wrap items-center gap-4">
          <div className="metric-row">
            <Layers3 className="h-3.5 w-3.5 text-white" />
            <span>{summary.activeSessions} active agents</span>
          </div>
          <div className="metric-row">
            <Cpu className="h-3.5 w-3.5 text-sentinel-ice" />
            <span>{summary.totalCpuPercent.toFixed(1)}% total CPU</span>
          </div>
          <div className="metric-row">
            <MemoryStick className="h-3.5 w-3.5 text-sentinel-accent" />
            <span>{summary.totalMemoryMb.toFixed(1)} MB memory</span>
          </div>
          <div className="metric-row">
            <GitBranch className="h-3.5 w-3.5 text-white" />
            <span>{summary.branch || 'No branch selected'}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <button
            className="metric-row transition hover:border-sentinel-accent/40 hover:bg-sentinel-accent/10 hover:text-white"
            onClick={onToggleConsole}
            type="button"
          >
            <TerminalSquare className="h-3.5 w-3.5 text-sentinel-accent" />
            <span>{consoleOpen ? 'Hide Console' : 'Show Console'}</span>
            <span className="font-mono text-[11px] text-sentinel-mist">Ctrl+~</span>
          </button>
          <div className="metric-row">
            <Layers3 className="h-3.5 w-3.5 text-white" />
            <span>{summary.totalProcesses} tracked processes</span>
          </div>
          <div className="metric-row">
            <Clock3 className="h-3.5 w-3.5 text-white" />
            <span>updated {formatTime(summary.lastUpdated)}</span>
          </div>
        </div>
      </div>
    </footer>
  )
}
