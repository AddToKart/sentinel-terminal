import { Terminal } from '@xterm/xterm'

type TerminalOptions = ConstructorParameters<typeof Terminal>[0]

export function createTerminalOptions(windowsBuildNumber?: number): TerminalOptions {
  return {
    allowTransparency: false,
    convertEol: false,
    cursorBlink: false,
    customGlyphs: false,
    fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    scrollback: 2000,
    smoothScrollDuration: 0,
    theme: {
      background: '#060a0f',
      black: '#060a0f'
    },
    windowsPty: {
      backend: 'conpty',
      buildNumber: windowsBuildNumber
    }
  }
}

export function installTerminalMaintenance(
  terminal: Terminal,
  isActive: () => boolean
): () => void {
  function refreshTerminalSurface(): void {
    if (!isActive()) {
      return
    }

    terminal.clearTextureAtlas()
    if (terminal.rows > 0) {
      terminal.refresh(0, Math.max(terminal.rows - 1, 0))
    }
  }

  const intervalId = window.setInterval(() => {
    refreshTerminalSurface()
  }, 90_000)

  const handleWindowFocus = (): void => {
    requestAnimationFrame(() => {
      refreshTerminalSurface()
    })
  }

  const handleVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') {
      return
    }

    requestAnimationFrame(() => {
      refreshTerminalSurface()
    })
  }

  window.addEventListener('focus', handleWindowFocus)
  document.addEventListener('visibilitychange', handleVisibilityChange)

  return () => {
    window.clearInterval(intervalId)
    window.removeEventListener('focus', handleWindowFocus)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
}
