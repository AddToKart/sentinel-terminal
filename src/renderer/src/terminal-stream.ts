import type { SessionOutputEvent } from '@shared/types'

type OutputListener = (data: string) => void

interface SessionOutputBuffer {
  chunks: string[]
  totalLength: number
}

const MAX_BUFFER_LENGTH = 250_000

const buffers = new Map<string, SessionOutputBuffer>()
const listeners = new Map<string, Set<OutputListener>>()

let bridgeStarted = false

function getBuffer(sessionId: string): SessionOutputBuffer {
  let buffer = buffers.get(sessionId)
  if (!buffer) {
    buffer = { chunks: [], totalLength: 0 }
    buffers.set(sessionId, buffer)
  }

  return buffer
}

function trimBuffer(buffer: SessionOutputBuffer): void {
  while (buffer.totalLength > MAX_BUFFER_LENGTH && buffer.chunks.length > 1) {
    const removed = buffer.chunks.shift()
    if (!removed) {
      break
    }

    buffer.totalLength -= removed.length
  }
}

function dispatchOutput(event: SessionOutputEvent): void {
  const buffer = getBuffer(event.sessionId)
  buffer.chunks.push(event.data)
  buffer.totalLength += event.data.length
  trimBuffer(buffer)

  const sessionListeners = listeners.get(event.sessionId)
  if (!sessionListeners || sessionListeners.size === 0) {
    return
  }

  for (const listener of sessionListeners) {
    listener(event.data)
  }
}

function ensureBridge(): void {
  if (bridgeStarted) {
    return
  }

  bridgeStarted = true
  window.sentinel.onSessionOutput((event) => {
    dispatchOutput(event)
  })
}

export function subscribeToSessionOutput(
  sessionId: string,
  listener: OutputListener,
  options: { replay?: boolean } = {}
): () => void {
  ensureBridge()

  const replay = options.replay ?? true
  let sessionListeners = listeners.get(sessionId)
  if (!sessionListeners) {
    sessionListeners = new Set()
    listeners.set(sessionId, sessionListeners)
  }

  sessionListeners.add(listener)

  if (replay) {
    const replayData = buffers.get(sessionId)?.chunks.join('')
    if (replayData) {
      listener(replayData)
    }
  }

  return () => {
    const currentListeners = listeners.get(sessionId)
    if (!currentListeners) {
      return
    }

    currentListeners.delete(listener)
    if (currentListeners.size === 0) {
      listeners.delete(sessionId)
    }
  }
}

export function clearSessionOutput(sessionId: string): void {
  buffers.delete(sessionId)
  listeners.delete(sessionId)
}
