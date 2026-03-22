import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'

import { RUN_COMMAND_TIMEOUT_MS } from './constants'

export async function runCommand(file: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        windowsHide: true,
        timeout: RUN_COMMAND_TIMEOUT_MS
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message))
          return
        }

        resolve(stdout.trim())
      }
    )
  })
}

export async function runPowerShell(script: string): Promise<string> {
  return runCommand(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]
  )
}

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}
