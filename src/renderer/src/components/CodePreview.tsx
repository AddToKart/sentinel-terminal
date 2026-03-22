import { useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { FileCode2, Info, X } from 'lucide-react'
import type { SessionSummary } from '@shared/types'

interface CodePreviewProps {
  filePath: string | null
  projectPath: string | undefined
  sessions: SessionSummary[]
  onClose: () => void
}

export function CodePreview({ filePath, projectPath, sessions, onClose }: CodePreviewProps): JSX.Element | null {
  const [originalContent, setOriginalContent] = useState<string>('')
  const [modifiedContent, setModifiedContent] = useState<string>('')
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Identify which agents have modified this file
  const modifyingSessions = sessions.filter((session) => {
    // If we have diffBadges or modifiedPaths in the future we could check.
    // For now we just check all sessions if they are selected.
    return true
  })

  useEffect(() => {
    if (!filePath || !projectPath) return
    if (!activeSessionId && modifyingSessions.length > 0) {
      setActiveSessionId(modifyingSessions[0].id)
    }
  }, [filePath, projectPath, modifyingSessions.length, activeSessionId])

  useEffect(() => {
    if (!filePath || !projectPath) return

    let cancelled = false
    setLoading(true)

    async function loadContents() {
      try {
        const rootContent = await window.sentinel.readFile(filePath!)
        if (cancelled) return
        setOriginalContent(rootContent)
        
        let worktreeContent = rootContent
        const activeSession = sessions.find(s => s.id === activeSessionId)
        
        if (activeSession) {
          // Normalize paths for replacement
          const normalizedFilePath = filePath!.replace(/\\/g, '/')
          const normalizedProjectPath = projectPath!.replace(/\\/g, '/')
          const relativePath = normalizedFilePath.startsWith(normalizedProjectPath) 
            ? normalizedFilePath.slice(normalizedProjectPath.length) 
            : filePath!

          const worktreeFilePath = `${activeSession.worktreePath}${relativePath.replace(/\//g, '\\')}`
          worktreeContent = await window.sentinel.readFile(worktreeFilePath)
        }

        if (!cancelled) {
          setModifiedContent(worktreeContent)
        }
      } catch (e) {
        // File might not exist or be binary
        if (!cancelled) {
          setOriginalContent('// Unable to read file or file is binary.')
          setModifiedContent('// Unable to read file or file is binary.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadContents()
    return () => { cancelled = true }
  }, [filePath, projectPath, activeSessionId, sessions])

  if (!filePath) return null

  const fileName = filePath.split(/[\/\\]/).pop() || 'Unknown File'

  return (
    <div className="flex h-full flex-col overflow-hidden border border-white/10 bg-[#060a0f] text-sm">
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 bg-white/[0.02] px-3 py-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sentinel-mist font-medium">
            <FileCode2 className="h-4 w-4" />
            {fileName}
          </div>
          {modifyingSessions.length > 0 && (
            <select
              className="ml-4 border border-white/10 bg-black px-2 py-1 text-xs text-white outline-none"
              value={activeSessionId || ''}
              onChange={(e) => setActiveSessionId(e.target.value)}
            >
              <option value="">Original vs Original</option>
              {modifyingSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  Compare with {s.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2 text-sentinel-mist">
          <button className="hover:text-white" onClick={onClose} title="Close Preview">
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="relative flex-1 bg-[#1e1e1e]">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sentinel-mist">
            <Info className="mr-2 h-4 w-4 animate-pulse" /> Loading diff...
          </div>
        ) : (
          <DiffEditor
            height="100%"
            language={fileName.endsWith('.tsx') || fileName.endsWith('.ts') ? 'typescript' : 'javascript'}
            theme="vs-dark"
            original={originalContent}
            modified={modifiedContent}
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontFamily: 'JetBrains Mono, Cascadia Code, Consolas',
              fontSize: 13,
              scrollBeyondLastLine: false,
              wordWrap: 'on'
            }}
          />
        )}
      </div>
    </div>
  )
}
