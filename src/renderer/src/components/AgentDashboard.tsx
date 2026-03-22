import { Fragment } from 'react'
import { GripHorizontal, GripVertical } from 'lucide-react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'

import type { SessionCommandEntry, SessionSummary } from '@shared/types'

import { SessionTile } from './SessionTile'

interface AgentDashboardProps {
  sessions: SessionSummary[]
  histories: Record<string, SessionCommandEntry[]>
  onClose: (sessionId: string) => Promise<void>
  onToggleMaximize: (sessionId: string) => void
  maximizedSessionId: string | null
  fitNonce: number
}

function getColumnCount(sessionCount: number): number {
  if (sessionCount <= 1) {
    return 1
  }

  if (sessionCount === 2) {
    return 2
  }

  if (sessionCount <= 4) {
    return 2
  }

  if (sessionCount <= 9) {
    return 3
  }

  return Math.ceil(Math.sqrt(sessionCount))
}

function buildRows(sessions: SessionSummary[]): SessionSummary[][] {
  const columnCount = getColumnCount(sessions.length)
  const rowCount = Math.ceil(sessions.length / columnCount)
  const rows: SessionSummary[][] = []
  let cursor = 0

  const baseSize = Math.floor(sessions.length / rowCount)
  const remainder = sessions.length % rowCount

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const nextRowSize = baseSize + (rowIndex < remainder ? 1 : 0)
    rows.push(sessions.slice(cursor, cursor + nextRowSize))
    cursor += nextRowSize
  }

  return rows
}

function rowMinSize(rowCount: number): number {
  return rowCount <= 1 ? 100 : Math.max(16, Math.floor(100 / (rowCount + 2)))
}

function columnMinSize(columnCount: number): number {
  return columnCount <= 1 ? 100 : Math.max(14, Math.floor(100 / (columnCount + 2)))
}

function DashboardResizeHandle({ direction }: { direction: 'horizontal' | 'vertical' }): JSX.Element {
  const isHorizontal = direction === 'horizontal'

  return (
    <PanelResizeHandle
      className={
        isHorizontal
          ? 'dashboard-handle dashboard-handle-horizontal'
          : 'dashboard-handle dashboard-handle-vertical'
      }
    >
      <div className="dashboard-handle-bar">
        {isHorizontal ? <GripHorizontal className="h-3.5 w-3.5" /> : <GripVertical className="h-3.5 w-3.5" />}
      </div>
    </PanelResizeHandle>
  )
}

export function AgentDashboard({
  sessions,
  histories,
  onClose,
  onToggleMaximize,
  maximizedSessionId,
  fitNonce
}: AgentDashboardProps): JSX.Element {
  const visibleSessions = maximizedSessionId
    ? sessions.filter((session) => session.id === maximizedSessionId)
    : sessions

  if (visibleSessions.length === 0) {
    return <div className="h-full min-h-0 min-w-0 overflow-hidden border border-white/10 bg-black/10" />
  }

  if (visibleSessions.length === 1 && maximizedSessionId) {
    const session = visibleSessions[0]

    return (
      <div className="h-full min-h-0 min-w-0 overflow-hidden border border-white/10 bg-black/10 p-2">
        <div className="h-full min-h-0 min-w-0 p-1.5">
          <SessionTile
            fitNonce={fitNonce}
            historyEntries={histories[session.id] ?? []}
            isMaximized
            onClose={onClose}
            onToggleMaximize={onToggleMaximize}
            session={session}
          />
        </div>
      </div>
    )
  }

  const rows = buildRows(visibleSessions)
  const dashboardId = visibleSessions.map((session) => session.id).join('-')

  return (
    <div className="h-full min-h-0 min-w-0 overflow-hidden border border-white/10 bg-black/10 p-2">
      <PanelGroup
        autoSaveId={`sentinel-dashboard-${dashboardId}`}
        className="h-full min-h-0"
        direction="vertical"
      >
        {rows.map((row, rowIndex) => {
          const rowId = row.map((session) => session.id).join('-')

          return (
            <Fragment key={rowId}>
              {rowIndex > 0 && <DashboardResizeHandle direction="horizontal" />}
              <Panel
                className="min-h-0"
                defaultSize={100 / rows.length}
                minSize={rowMinSize(rows.length)}
              >
                <PanelGroup
                  autoSaveId={`sentinel-dashboard-row-${rowId}`}
                  className="h-full min-h-0"
                  direction="horizontal"
                >
                  {row.map((session, columnIndex) => (
                    <Fragment key={session.id}>
                      {columnIndex > 0 && <DashboardResizeHandle direction="vertical" />}
                      <Panel
                        className="min-h-0 min-w-0"
                        defaultSize={100 / row.length}
                        minSize={columnMinSize(row.length)}
                      >
                        <div className="h-full min-h-0 min-w-0 p-1.5">
                          <SessionTile
                            fitNonce={fitNonce}
                            historyEntries={histories[session.id] ?? []}
                            isMaximized={false}
                            onClose={onClose}
                            onToggleMaximize={onToggleMaximize}
                            session={session}
                          />
                        </div>
                      </Panel>
                    </Fragment>
                  ))}
                </PanelGroup>
              </Panel>
            </Fragment>
          )
        })}
      </PanelGroup>
    </div>
  )
}
