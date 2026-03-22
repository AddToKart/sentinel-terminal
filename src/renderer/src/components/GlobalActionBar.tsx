import { useEffect, useRef, useState } from 'react'
import { TerminalSquare, RefreshCw, FolderOpen, X, Command } from 'lucide-react'

interface Action {
  id: string
  label: string
  icon: JSX.Element
  execute: () => void
}

interface GlobalActionBarProps {
  isOpen: boolean
  onClose: () => void
  actions: Action[]
}

export function GlobalActionBar({ isOpen, onClose, actions }: GlobalActionBarProps): JSX.Element | null {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filteredActions = actions.filter((action) =>
    action.label.toLowerCase().includes(query.toLowerCase())
  )

  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!isOpen) return
      
      if (e.key === 'Escape') {
        onClose()
        return
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => (prev + 1) % filteredActions.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => (prev - 1 + filteredActions.length) % filteredActions.length)
      } else if (e.key === 'Enter' && filteredActions.length > 0) {
        e.preventDefault()
        filteredActions[selectedIndex].execute()
        onClose()
      }
    }

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown, { capture: true })
    }
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [isOpen, filteredActions, selectedIndex, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div 
        className="w-full max-w-lg overflow-hidden rounded-lg shadow-2xl bg-sentinel-ink/90 border border-white/10"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <Command className="h-4 w-4 text-sentinel-accent" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-sentinel-mist"
            placeholder="Type a command or search..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="text-[10px] uppercase font-mono text-sentinel-mist">ESC to close</div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-2">
          {filteredActions.length === 0 ? (
            <div className="px-4 py-3 text-sm text-sentinel-mist">No matching actions.</div>
          ) : (
            filteredActions.map((action, index) => (
              <button
                key={action.id}
                className={`w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                  index === selectedIndex ? 'bg-sentinel-accent/20 text-white' : 'text-sentinel-mist hover:bg-white/5 hover:text-white'
                }`}
                onClick={() => {
                  action.execute()
                  onClose()
                }}
              >
                <div className="flex shrink-0 w-6 items-center justify-center">
                  {action.icon}
                </div>
                {action.label}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
