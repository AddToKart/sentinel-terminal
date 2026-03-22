declare module 'pidusage' {
  export interface Status {
    cpu: number
    memory: number
    pid?: number
    ppid?: number
    ctime?: number
    elapsed?: number
    timestamp?: number
  }

  type Pid = number | string

  export default function pidusage(pid: Pid): Promise<Status>
  export default function pidusage(pid: Pid[]): Promise<Record<string, Status>>

  export function clear(): void
}
