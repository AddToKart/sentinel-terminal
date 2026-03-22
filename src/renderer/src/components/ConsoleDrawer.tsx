import { ChevronDown, TerminalSquare } from 'lucide-react'

import type { ActivityLogEntry } from '@shared/types'

interface ConsoleDrawerProps {
  entries: ActivityLogEntry[]
  open: boolean
  onToggleOpen: () => void
}

function statusTone(status: ActivityLogEntry['status']): string {
  if (status === 'completed') {
    return 'border-emerald-400/30 bg-emerald-400/12 text-emerald-100'
  }

  if (status === 'failed') {
    return 'border-rose-400/30 bg-rose-400/12 text-rose-100'
  }

  return 'border-sky-400/30 bg-sky-400/12 text-sky-100'
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function ConsoleDrawer({ entries, open, onToggleOpen }: ConsoleDrawerProps): JSX.Element {
  return (
    <section
      className={`overflow-hidden border-t bg-[#060c12]/96 transition-[height,opacity,border-color] duration-200 ${
        open ? 'h-72 border-white/10 opacity-100' : 'h-0 border-transparent opacity-0'
      }`}
    >
      <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <header className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="inline-flex items-center gap-2 border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-white">
              <TerminalSquare className="h-3.5 w-3.5 text-sentinel-accent" />
              Console
            </div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-sentinel-mist">
              Background Git activity
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-[11px] uppercase tracking-[0.22em] text-sentinel-mist">Ctrl+~</div>
            <button
              className="inline-flex h-8 w-8 items-center justify-center border border-white/10 bg-white/[0.04] text-sentinel-mist transition hover:border-sentinel-accent/40 hover:bg-sentinel-accent/10 hover:text-white"
              onClick={onToggleOpen}
              title="Hide console drawer"
              type="button"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="min-h-0 overflow-auto p-3">
          {entries.length === 0 ? (
            <div className="flex h-full items-center border border-white/10 bg-white/[0.03] px-4 text-sm text-sentinel-mist">
              No Git activity yet.
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="grid min-w-0 grid-cols-[74px_92px_minmax(0,1fr)] items-start gap-3 border border-white/10 bg-white/[0.03] px-3 py-2 text-xs"
                >
                  <div className="pt-1 font-mono text-sentinel-mist">{formatTime(entry.timestamp)}</div>
                  <div
                    className={`inline-flex items-center justify-center border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] ${statusTone(entry.status)}`}
                  >
                    {entry.status}
                  </div>
                  <div className="min-w-0 font-mono text-sentinel-mist">
                    <div className="truncate text-white">{entry.command}</div>
                    <div className="truncate text-[11px] text-sentinel-mist">{entry.cwd}</div>
                    {entry.detail && <div className="mt-1 truncate text-[11px] text-rose-200/80">{entry.detail}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
