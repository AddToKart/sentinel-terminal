import type { ActivityLogEntry } from '@shared/types'

interface ActivityLogProps {
  entries: ActivityLogEntry[]
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

export function ActivityLog({ entries }: ActivityLogProps): JSX.Element {
  const visibleEntries = entries.slice(0, 6)

  return (
    <section className="border-t border-white/10 bg-black/30 px-8 py-3">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sentinel-mist">Global Activity Log</div>
        <div className="text-[11px] uppercase tracking-[0.22em] text-sentinel-mist">Background Git commands</div>
      </div>

      <div className="grid h-[118px] min-h-0 gap-2 overflow-hidden">
        {visibleEntries.length === 0 ? (
          <div className="flex h-full items-center border border-white/10 bg-white/[0.03] px-4 text-sm text-sentinel-mist">
            No Git activity yet.
          </div>
        ) : (
          visibleEntries.map((entry) => (
            <div
              key={entry.id}
              className="grid min-w-0 grid-cols-[72px_88px_minmax(0,1fr)] items-center gap-3 border border-white/10 bg-white/[0.03] px-3 py-2 text-xs"
            >
              <div className="font-mono text-sentinel-mist">{formatTime(entry.timestamp)}</div>
              <div className={`inline-flex items-center justify-center border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] ${statusTone(entry.status)}`}>
                {entry.status}
              </div>
              <div className="min-w-0 font-mono text-sentinel-mist">
                <div className="truncate text-white">{entry.command}</div>
                {entry.detail && <div className="truncate text-[11px] text-rose-200/80">{entry.detail}</div>}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
