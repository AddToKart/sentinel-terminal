import path from 'node:path'

import * as nodePty from 'node-pty'

import type { IdeTerminalOutputEvent, IdeTerminalState, ProjectState, SessionApplyResult } from '@shared/types'

import { CLOSE_TIMEOUT_MS } from './constants'
import { arrayEquals, delay } from './helpers'
import { ProcessService } from './ProcessService'
import type { IdeTerminalRecord, SessionRecord } from './types'
import { WorkspaceService } from './WorkspaceService'

interface IdeServiceOptions {
  processService: ProcessService
  workspaceService: WorkspaceService
  emitState: (state: IdeTerminalState) => void
  emitOutput: (payload: IdeTerminalOutputEvent) => void
}

export class IdeService {
  private readonly _processService: ProcessService
  private readonly _workspaceService: WorkspaceService
  private readonly _emitState: (state: IdeTerminalState) => void
  private readonly _emitOutput: (payload: IdeTerminalOutputEvent) => void

  private _record: IdeTerminalRecord | null = null
  private _state: IdeTerminalState = {
    status: 'idle',
    shell: 'powershell.exe',
    modifiedPaths: []
  }
  private _workspacePath?: string
  private _workspaceProjectRoot?: string
  private _sandboxState?: NonNullable<SessionRecord['sandboxState']>

  constructor(options: IdeServiceOptions) {
    this._processService = options.processService
    this._workspaceService = options.workspaceService
    this._emitState = options.emitState
    this._emitOutput = options.emitOutput
  }

  getState(): IdeTerminalState {
    return structuredClone(this._state)
  }

  getRecord(): IdeTerminalRecord | null {
    return this._record
  }

  async handleProjectChanged(projectPath?: string): Promise<void> {
    const normalizedProjectPath = projectPath ? path.resolve(projectPath) : undefined
    const ideTerminalNeedsRestart =
      this._record &&
      path.resolve(this._record.state.cwd || '') !== normalizedProjectPath

    if (ideTerminalNeedsRestart) {
      await this.closeTerminal()
    }

    if (
      this._workspaceProjectRoot &&
      path.resolve(this._workspaceProjectRoot) !== normalizedProjectPath
    ) {
      await this._cleanupWorkspace(projectPath)
    }
  }

  async ensureTerminal(project: ProjectState): Promise<IdeTerminalState> {
    const projectPath = project.path
    if (!projectPath) {
      this._state = this._createIdleState()
      this._emitStateChange()
      return structuredClone(this._state)
    }

    const workspace = await this._ensureWorkspace(project)
    const activeRecord = this._record

    if (
      activeRecord &&
      path.resolve(activeRecord.state.cwd || '') === path.resolve(workspace.workspacePath) &&
      activeRecord.state.status !== 'closed' &&
      activeRecord.state.status !== 'error'
    ) {
      return structuredClone(activeRecord.state)
    }

    if (activeRecord) {
      await this.closeTerminal()
    }

    return this._spawnTerminal(project, workspace.workspacePath, workspace.modifiedPaths)
  }

  async sendInput(project: ProjectState, data: string): Promise<void> {
    if (!this._record) {
      await this.ensureTerminal(project)
    }

    this._record?.terminal.write(data)
  }

  async resizeTerminal(project: ProjectState, cols: number, rows: number): Promise<void> {
    if (cols <= 0 || rows <= 0) {
      return
    }

    if (!this._record) {
      await this.ensureTerminal(project)
    }

    if (!this._record) {
      return
    }

    if (this._record.terminalSize.cols === cols && this._record.terminalSize.rows === rows) {
      return
    }

    this._record.terminalSize = { cols, rows }
    this._record.terminal.resize(cols, rows)
  }

  async writeFile(project: ProjectState, relativePath: string, content: string): Promise<void> {
    const workspace = await this._ensureWorkspace(project)
    await this._workspaceService.writeWorkspaceFile(workspace.workspacePath, relativePath, content)
    await this.refreshWorkspaceDiffs()
  }

  async applyWorkspace(project: ProjectState): Promise<SessionApplyResult> {
    const projectPath = project.path
    const workspace = await this._ensureWorkspace(project)
    if (!projectPath) {
      throw new Error('IDE workspace is unavailable.')
    }

    const applied = await this._workspaceService.applyIdeWorkspace(
      projectPath,
      workspace.workspacePath,
      workspace.sandboxState
    )

    this._sandboxState = applied.sandboxState
    this._setModifiedPaths(applied.modifiedPaths)
    return applied.result
  }

  async discardWorkspaceChanges(project: ProjectState): Promise<void> {
    const projectPath = project.path
    const workspace = await this._ensureWorkspace(project)
    if (!projectPath) {
      throw new Error('Project is unavailable.')
    }

    const discarded = await this._workspaceService.discardIdeWorkspaceChanges(
      projectPath,
      workspace.workspacePath
    )

    this._sandboxState = discarded.sandboxState
    this._setModifiedPaths(discarded.modifiedPaths)
  }

  async refreshWorkspaceDiffs(): Promise<void> {
    if (!(this._workspacePath && this._sandboxState)) {
      return
    }

    const refreshed = await this._workspaceService.refreshIdeWorkspaceDiffs(
      this._workspacePath,
      this._sandboxState
    )
    this._sandboxState = refreshed.sandboxState
    this._setModifiedPaths(refreshed.modifiedPaths)
  }

  async closeTerminal(): Promise<void> {
    const record = this._record
    if (!record) {
      return
    }

    if (!record.closeRequested) {
      record.closeRequested = true

      if (
        record.state.status === 'starting' ||
        record.state.status === 'ready' ||
        record.state.status === 'error'
      ) {
        record.state.status = 'closing'
        record.state.error = undefined
        this._state = { ...record.state }
        this._emitStateChange()
      }

      await this._processService.terminateProcessId(record.state.pid)

      try {
        record.terminal.kill()
      } catch {
        // The PTY may already be shutting down.
      }
    }

    const closedInTime = await Promise.race([
      record.closePromise.then(() => true),
      delay(CLOSE_TIMEOUT_MS).then(() => false)
    ])

    if (!closedInTime) {
      await this._finalizeTerminal(record, record.state.exitCode ?? null, {
        error: 'Sentinel forced the IDE terminal to close after the shell stopped responding.'
      })
    }
  }

  dispose(): void {
    if (!this._record) {
      return
    }

    this._record.closeRequested = true
    void this._processService.terminateProcessId(this._record.state.pid)

    try {
      this._record.terminal.kill()
    } catch {
      // Ignore teardown errors while the app is closing.
    }
  }

  private _createIdleState(projectPath?: string): IdeTerminalState {
    return {
      status: 'idle',
      shell: 'powershell.exe',
      cwd: this._workspacePath ?? projectPath,
      workspacePath: this._workspacePath,
      modifiedPaths: this._state.modifiedPaths
    }
  }

  private _emitStateChange(): void {
    this._emitState(structuredClone(this._state))
  }

  private _setModifiedPaths(modifiedPaths: string[]): void {
    if (arrayEquals(this._state.modifiedPaths, modifiedPaths)) {
      return
    }

    this._state = {
      ...this._state,
      cwd: this._workspacePath,
      workspacePath: this._workspacePath,
      modifiedPaths
    }
    this._emitStateChange()
  }

  private async _ensureWorkspace(project: ProjectState): Promise<{
    workspacePath: string
    sandboxState: NonNullable<SessionRecord['sandboxState']>
    modifiedPaths: string[]
  }> {
    const projectRoot = project.path
    if (!projectRoot) {
      throw new Error('Open a project folder before using IDE mode.')
    }

    if (
      this._workspacePath &&
      this._workspaceProjectRoot &&
      this._sandboxState &&
      path.resolve(this._workspaceProjectRoot) === path.resolve(projectRoot)
    ) {
      return {
        workspacePath: this._workspacePath,
        sandboxState: this._sandboxState,
        modifiedPaths: this._state.modifiedPaths
      }
    }

    if (this._workspacePath) {
      await this._cleanupWorkspace(project.path)
    }

    const workspace = await this._workspaceService.createIdeWorkspace(project)
    this._workspacePath = workspace.workspacePath
    this._workspaceProjectRoot = projectRoot
    this._sandboxState = workspace.sandboxState
    this._state = {
      ...this._state,
      cwd: workspace.workspacePath,
      workspacePath: workspace.workspacePath,
      modifiedPaths: []
    }
    this._emitStateChange()

    return {
      workspacePath: workspace.workspacePath,
      sandboxState: workspace.sandboxState,
      modifiedPaths: []
    }
  }

  private async _cleanupWorkspace(projectPath?: string): Promise<void> {
    const workspacePath = this._workspacePath

    this._workspacePath = undefined
    this._workspaceProjectRoot = undefined
    this._sandboxState = undefined
    this._state = {
      ...this._state,
      cwd: projectPath,
      workspacePath: undefined,
      modifiedPaths: []
    }
    this._emitStateChange()

    await this._workspaceService.cleanupIdeWorkspace(workspacePath)
  }

  private async _spawnTerminal(
    project: ProjectState,
    workspacePath: string,
    modifiedPaths: string[]
  ): Promise<IdeTerminalState> {
    let resolveClosed: () => void = () => undefined
    const closePromise = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })

    const terminal = nodePty.spawn('powershell.exe', ['-NoLogo'], {
      cols: 120,
      rows: 28,
      cwd: workspacePath,
      name: 'xterm-256color',
      useConpty: true,
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        SENTINEL_IDE_TERMINAL: '1',
        SENTINEL_PROJECT_ROOT: project.path || '',
        SENTINEL_WORKSPACE_PATH: workspacePath,
        SENTINEL_WORKSPACE_MODE: 'sandbox-copy'
      }
    })

    const record: IdeTerminalRecord = {
      state: {
        status: 'starting',
        shell: 'powershell.exe',
        cwd: workspacePath,
        workspacePath,
        pid: terminal.pid,
        createdAt: Date.now(),
        modifiedPaths
      },
      terminal,
      terminalSize: {
        cols: 120,
        rows: 28
      },
      closePromise,
      resolveClosed,
      closeRequested: false
    }

    this._record = record
    this._state = { ...record.state }
    this._emitStateChange()

    terminal.onData((data) => {
      if (record.state.status === 'starting') {
        record.state.status = 'ready'
        this._state = { ...record.state }
        this._emitStateChange()
      }

      this._emitOutput({ data })
    })

    terminal.onExit(({ exitCode }) => {
      void this._finalizeTerminal(record, exitCode)
    })

    return structuredClone(record.state)
  }

  private async _finalizeTerminal(
    record: IdeTerminalRecord,
    exitCode: number | null,
    options?: { error?: string }
  ): Promise<void> {
    if (record.finalizePromise) {
      await record.finalizePromise
      return
    }

    record.finalizePromise = (async () => {
      await this._processService.terminateProcessId(record.state.pid)

      const closedCleanly = exitCode === 0 || exitCode === null
      record.state.exitCode = exitCode
      record.state.status = record.closeRequested || closedCleanly ? 'closed' : 'error'

      if (options?.error) {
        record.state.error = options.error
      } else if (!record.closeRequested && !closedCleanly) {
        record.state.error = `PowerShell exited unexpectedly with code ${exitCode}.`
      } else {
        record.state.error = undefined
      }

      this._state = { ...record.state }
      if (this._record === record) {
        this._record = null
      }

      this._emitStateChange()
      record.resolveClosed()
    })()

    await record.finalizePromise
  }
}
