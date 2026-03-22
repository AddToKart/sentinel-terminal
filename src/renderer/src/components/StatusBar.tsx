import { Clock3, Cpu, GitBranch, Layers3, MemoryStick } from 'lucide-react'

import type { WorkspaceSummary } from '@shared/types'

interface StatusBarProps {
  summary: WorkspaceSummary
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function StatusBar({ summary }: StatusBarProps): JSX.Element {
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
