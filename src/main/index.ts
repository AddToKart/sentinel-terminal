import path from 'node:path'

import { app, BrowserWindow, ipcMain, shell } from 'electron'

import type { CreateSessionInput } from '@shared/types'

import { SessionManager } from './session-manager'

let mainWindow: BrowserWindow | null = null
const sessionManager = new SessionManager()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1020,
    minWidth: 1200,
    minHeight: 760,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#05090f',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#071016',
      symbolColor: '#d6e2f2',
      height: 36
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function sendToRenderer<T>(channel: string, payload: T): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  mainWindow.webContents.send(channel, payload)
}

function registerIpcHandlers(): void {
  ipcMain.handle('sentinel:bootstrap', () => sessionManager.bootstrap())
  ipcMain.handle('sentinel:select-project', () => sessionManager.selectProject())
  ipcMain.handle('sentinel:refresh-project', () => sessionManager.refreshProject())
  ipcMain.handle('sentinel:create-session', (_event, input: CreateSessionInput | undefined) =>
    sessionManager.createSession(input)
  )
  ipcMain.handle('sentinel:close-session', (_event, sessionId: string) =>
    sessionManager.closeSession(sessionId)
  )
  ipcMain.handle('sentinel:resize-session', (_event, payload: { sessionId: string; cols: number; rows: number }) =>
    sessionManager.resizeSession(payload.sessionId, payload.cols, payload.rows)
  )
  ipcMain.handle('sentinel:send-input', (_event, payload: { sessionId: string; data: string }) =>
    sessionManager.sendInput(payload.sessionId, payload.data)
  )
  ipcMain.handle('sentinel:reveal-in-file-explorer', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })
  ipcMain.handle('sentinel:open-in-system-editor', async (_event, filePath: string) => {
    await shell.openPath(filePath)
  })
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

  sessionManager.on('session-output', (payload) => {
    sendToRenderer('sentinel:session-output', payload)
  })

  sessionManager.on('session-state', (session) => {
    sendToRenderer('sentinel:session-state', session)
  })

  sessionManager.on('session-metrics', (payload) => {
    sendToRenderer('sentinel:session-metrics', payload)
  })

  sessionManager.on('session-history', (payload) => {
    sendToRenderer('sentinel:session-history', payload)
  })

  sessionManager.on('session-diff', (payload) => {
    sendToRenderer('sentinel:session-diff', payload)
  })

  sessionManager.on('workspace-state', (summary) => {
    sendToRenderer('sentinel:workspace-state', summary)
  })

  sessionManager.on('activity-log', (entry) => {
    sendToRenderer('sentinel:activity-log', entry)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  sessionManager.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
