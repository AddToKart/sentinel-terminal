import pidusage, { clear as clearPidusage } from 'pidusage'

import { normalizeSessionPaths, parseGitStatusOutput } from './helpers'
import type { ProcessTreeSnapshot, RawProcessTreeSnapshot, SessionRecord } from './types'
import { pathExists, runCommand, runPowerShell } from './commands'

export function clearProcessUsageCache(): void {
  clearPidusage()
}

export async function collectWorktreeDiffs(records: SessionRecord[]): Promise<Map<string, string[]>> {
  const updates = await Promise.all(
    records.map(async (record) => {
      if (!(await pathExists(record.summary.worktreePath))) {
        return [record.summary.id, [] as string[]] as const
      }

      try {
        const raw = await runCommand(
          'git',
          ['-C', record.summary.worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
          record.summary.worktreePath
        )

        return [
          record.summary.id,
          normalizeSessionPaths(record.summary.projectRoot, parseGitStatusOutput(raw))
        ] as const
      } catch {
        return [record.summary.id, [] as string[]] as const
      }
    })
  )

  return new Map(updates)
}

export async function collectPidUsage(
  processIds: number[]
): Promise<Map<number, { cpu: number; memory: number }>> {
  const uniquePids = [...new Set(processIds.filter((pid) => Number.isInteger(pid) && pid > 0))]
  if (uniquePids.length === 0) {
    return new Map()
  }

  try {
    const usage = await pidusage(uniquePids)
    const usageMap = new Map<number, { cpu: number; memory: number }>()

    for (const processId of uniquePids) {
      const stats = usage[String(processId)] ?? usage[processId]
      if (!stats) {
        continue
      }

      usageMap.set(processId, {
        cpu: typeof stats.cpu === 'number' ? stats.cpu : 0,
        memory: typeof stats.memory === 'number' ? stats.memory : 0
      })
    }

    return usageMap
  } catch {
    return new Map()
  }
}

export async function collectProcessTreeSnapshots(
  rootIds: number[]
): Promise<Map<number, ProcessTreeSnapshot>> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$rootIds=@(${rootIds.join(',')})`,
    '$children=@{}',
    'Get-CimInstance Win32_Process | ForEach-Object {',
    "  $parent=[string]$_.ParentProcessId",
    '  if (-not $children.ContainsKey($parent)) { $children[$parent]=New-Object System.Collections.Generic.List[int] }',
    '  $children[$parent].Add([int]$_.ProcessId) | Out-Null',
    '}',
    '$result=@()',
    'foreach ($rootId in $rootIds) {',
    "  $queue=New-Object 'System.Collections.Generic.Queue[int]'",
    "  $seen=New-Object 'System.Collections.Generic.HashSet[int]'",
    '  $queue.Enqueue([int]$rootId)',
    '  while ($queue.Count -gt 0) {',
    '    $current=$queue.Dequeue()',
    '    if ($seen.Add($current)) {',
    '      $key=[string]$current',
    '      if ($children.ContainsKey($key)) {',
    '        foreach ($child in $children[$key]) { $queue.Enqueue([int]$child) }',
    '      }',
    '    }',
    '  }',
    '  $ids=@($seen)',
    '  $stats=@()',
    '  if ($ids.Count -gt 0) { $stats=Get-Process -Id $ids -ErrorAction SilentlyContinue }',
    '  $cpu=0.0',
    '  $workingSet=0',
    '  $handles=0',
    '  $threads=0',
    '  foreach ($proc in $stats) {',
    '    if ($null -ne $proc.CPU) { $cpu += [double]$proc.CPU }',
    '    if ($null -ne $proc.WorkingSet64) { $workingSet += [int64]$proc.WorkingSet64 }',
    '    if ($null -ne $proc.HandleCount) { $handles += [int]$proc.HandleCount }',
    '    if ($null -ne $proc.Threads) { $threads += $proc.Threads.Count }',
    '  }',
    '  $result += [pscustomobject]@{',
    '    RootId=[int]$rootId',
    '    CpuTotalSeconds=[double]$cpu',
    '    WorkingSetBytes=[int64]$workingSet',
    '    HandleCount=[int]$handles',
    '    ThreadCount=[int]$threads',
    '    ProcessCount=[int]$ids.Count',
    '    ProcessIds=@($ids)',
    '  }',
    '}',
    '$result | ConvertTo-Json -Compress'
  ].join('; ')

  let raw = ''

  try {
    raw = await runPowerShell(script)
  } catch {
    return new Map()
  }

  if (!raw) {
    return new Map()
  }

  const parsed = JSON.parse(raw) as RawProcessTreeSnapshot | RawProcessTreeSnapshot[]
  const snapshots = Array.isArray(parsed) ? parsed : [parsed]

  return new Map(
    snapshots.map((snapshot) => [
      snapshot.RootId,
      {
        rootId: snapshot.RootId,
        cpuTotalSeconds: snapshot.CpuTotalSeconds,
        workingSetBytes: snapshot.WorkingSetBytes,
        handleCount: snapshot.HandleCount,
        threadCount: snapshot.ThreadCount,
        processCount: snapshot.ProcessCount,
        processIds: Array.isArray(snapshot.ProcessIds) ? snapshot.ProcessIds : []
      }
    ])
  )
}
