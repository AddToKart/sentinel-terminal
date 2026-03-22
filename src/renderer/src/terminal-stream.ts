import type { IdeTerminalOutputEvent, SessionOutputEvent } from '@shared/types'

type OutputListener = (data: string) => void

interface OutputBuffer {
  chunks: string[]
  totalLength: number
}

interface OutputStore {
  clear: (key: string) => void
  push: (key: string, data: string) => void
  subscribe: (key: string, listener: OutputListener, replay?: boolean) => () => void
}

const MAX_BUFFER_LENGTH = 250_000
const IDE_TERMINAL_KEY = 'ide-terminal'

function createOutputStore(): OutputStore {
  const buffers = new Map<string, OutputBuffer>()
  const listeners = new Map<string, Set<OutputListener>>()

  function getBuffer(key: string): OutputBuffer {
    let buffer = buffers.get(key)
    if (!buffer) {
      buffer = { chunks: [], totalLength: 0 }
      buffers.set(key, buffer)
    }

    return buffer
  }

  function trimBuffer(buffer: OutputBuffer): void {
    while (buffer.totalLength > MAX_BUFFER_LENGTH && buffer.chunks.length > 1) {
      const removed = buffer.chunks.shift()
      if (!removed) {
        break
      }

      buffer.totalLength -= removed.length
    }
  }

  return {
    clear(key: string) {
      buffers.delete(key)
      listeners.delete(key)
    },
    push(key: string, data: string) {
      const buffer = getBuffer(key)
      buffer.chunks.push(data)
      buffer.totalLength += data.length
      trimBuffer(buffer)

      const scopedListeners = listeners.get(key)
      if (!scopedListeners || scopedListeners.size === 0) {
        return
      }

      for (const listener of scopedListeners) {
        listener(data)
      }
    },
    subscribe(key: string, listener: OutputListener, replay = true) {
      let scopedListeners = listeners.get(key)
      if (!scopedListeners) {
        scopedListeners = new Set()
        listeners.set(key, scopedListeners)
      }

      scopedListeners.add(listener)

      if (replay) {
        const replayData = buffers.get(key)?.chunks.join('')
        if (replayData) {
          listener(replayData)
        }
      }

      return () => {
        const currentListeners = listeners.get(key)
        if (!currentListeners) {
          return
        }

        currentListeners.delete(listener)
        if (currentListeners.size === 0) {
          listeners.delete(key)
        }
      }
    }
  }
}

const store = createOutputStore()

let sessionBridgeStarted = false
let ideBridgeStarted = false

function ensureSessionBridge(): void {
  if (sessionBridgeStarted) {
    return
  }

  if (typeof window === 'undefined' || typeof window.sentinel === 'undefined') {
    return
  }

  sessionBridgeStarted = true
  window.sentinel.onSessionOutput((event: SessionOutputEvent) => {
    store.push(event.sessionId, event.data)
  })
}

function ensureIdeBridge(): void {
  if (ideBridgeStarted) {
    return
  }

  if (typeof window === 'undefined' || typeof window.sentinel === 'undefined') {
    return
  }

  ideBridgeStarted = true
  window.sentinel.onIdeTerminalOutput((event: IdeTerminalOutputEvent) => {
    store.push(IDE_TERMINAL_KEY, event.data)
  })
}

export function subscribeToSessionOutput(
  sessionId: string,
  listener: OutputListener,
  options: { replay?: boolean } = {}
): () => void {
  ensureSessionBridge()
  return store.subscribe(sessionId, listener, options.replay ?? true)
}

export function clearSessionOutput(sessionId: string): void {
  store.clear(sessionId)
}

export function subscribeToIdeTerminalOutput(
  listener: OutputListener,
  options: { replay?: boolean } = {}
): () => void {
  ensureIdeBridge()
  return store.subscribe(IDE_TERMINAL_KEY, listener, options.replay ?? true)
}

export function clearIdeTerminalOutput(): void {
  store.clear(IDE_TERMINAL_KEY)
}
