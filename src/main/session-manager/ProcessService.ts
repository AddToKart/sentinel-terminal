import { runCommand, runPowerShell } from './commands'
import { emptyMetrics, round } from './helpers'
import {
  clearProcessUsageCache,
  collectPidUsage,
  collectProcessTreeSnapshots
} from './runtime-monitor'
import type { IdeTerminalRecord, SessionRecord } from './types'

export class ProcessService {
  private readonly _pidRegistry = new Map<string, Set<number>>()

  registerSessionRootPid(sessionId: string, pid?: number): void {
    this._pidRegistry.set(
      sessionId,
      new Set(typeof pid === 'number' && pid > 0 ? [pid] : [])
    )
  }

  removeSession(sessionId: string): void {
    this._pidRegistry.delete(sessionId)
  }

  getTrackedPids(sessionId: string): number[] {
    const trackedPids = new Set(this._pidRegistry.get(sessionId) ?? [])

    return [...trackedPids]
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .sort((left, right) => right - left)
  }

  clearTrackedPids(sessionId: string): void {
    this._pidRegistry.set(sessionId, new Set())
  }

  async terminateProcessId(pid?: number): Promise<void> {
    if (!pid) {
      return
    }

    try {
      await runCommand('taskkill', ['/PID', String(pid), '/T', '/F'])
    } catch {
      // taskkill returns non-zero when the process has already exited.
    }
  }

  async terminateSessionProcesses(record: SessionRecord): Promise<void> {
    const rootPid = record.summary.pid
    const otherPids = this.getTrackedPids(record.summary.id).filter((pid) => pid !== rootPid)

    if (!rootPid && otherPids.length === 0) {
      return
    }

    if (rootPid) {
      await this.terminateProcessId(rootPid)
    }

    if (otherPids.length === 0) {
      return
    }

    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      `$ids=@(${otherPids.join(',')})`,
      'Get-Process -Id $ids -ErrorAction SilentlyContinue | Sort-Object Id -Descending | Stop-Process -Force'
    ].join('; ')

    try {
      await runPowerShell(script)
    } catch {
      // Processes may have exited naturally by the time cleanup runs.
    }

    this._pidRegistry.set(record.summary.id, new Set())
  }

  async refreshSessionMetrics(records: SessionRecord[]): Promise<number> {
    const rootIds = records
      .map((record) => record.summary.pid)
      .filter((pid): pid is number => typeof pid === 'number')

    const snapshotMap =
      rootIds.length > 0
        ? await collectProcessTreeSnapshots(rootIds)
        : new Map()
    const usageMap =
      snapshotMap.size > 0
        ? await collectPidUsage([...snapshotMap.values()].flatMap((snapshot) => snapshot.processIds))
        : new Map<number, { cpu: number; memory: number }>()
    const sampledAt = Date.now()

    for (const record of records) {
      const pid = record.summary.pid
      const snapshot = typeof pid === 'number' ? snapshotMap.get(pid) : undefined
      const processIds = snapshot?.processIds ?? []
      this._updateTrackedPids(record.summary.id, processIds)

      record.summary.metrics = snapshot
        ? (() => {
            const aggregateUsage = snapshot.processIds.reduce(
              (totals: { cpu: number; memory: number }, processId: number) => {
                const usage = usageMap.get(processId)
                if (!usage) {
                  return totals
                }

                return {
                  cpu: totals.cpu + usage.cpu,
                  memory: totals.memory + usage.memory
                }
              },
              { cpu: 0, memory: 0 }
            )

            return {
              cpuPercent: round(aggregateUsage.cpu, 1),
              memoryMb: round(aggregateUsage.memory / 1024 / 1024, 1),
              handleCount: snapshot.handleCount,
              threadCount: snapshot.threadCount,
              processCount: snapshot.processCount
            }
          })()
        : emptyMetrics()
    }

    return sampledAt
  }

  dispose(records: Iterable<SessionRecord>, ideRecord: IdeTerminalRecord | null): void {
    clearProcessUsageCache()

    for (const record of records) {
      record.closeRequested = true
      void this.terminateSessionProcesses(record)

      try {
        record.terminal.kill()
      } catch {
        // Ignore teardown errors while the app is closing.
      }
    }

    if (!ideRecord) {
      return
    }

    ideRecord.closeRequested = true
    void this.terminateProcessId(ideRecord.state.pid)

    try {
      ideRecord.terminal.kill()
    } catch {
      // Ignore teardown errors while the app is closing.
    }
  }

  private _updateTrackedPids(sessionId: string, processIds: number[]): void {
    this._pidRegistry.set(
      sessionId,
      new Set(processIds.filter((pid) => Number.isInteger(pid) && pid > 0))
    )
  }
}
