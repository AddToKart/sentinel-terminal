import { useCallback, useEffect, useState } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { Code2, Diff, FileCode2, Save, X } from 'lucide-react'
import type { SessionSummary } from '@shared/types'

interface CodePreviewProps {
  filePath: string | null
  projectPath: string | undefined
  sessions: SessionSummary[]
  onClose: () => void
}

type ViewTab = 'edit' | 'diff'

function getLanguage(fileName: string): string {
  if (/\.(tsx?)$/.test(fileName)) return 'typescript'
  if (/\.(jsx?)$/.test(fileName)) return 'javascript'
  if (/\.css$/.test(fileName)) return 'css'
  if (/\.json$/.test(fileName)) return 'json'
  if (/\.(ya?ml)$/.test(fileName)) return 'yaml'
  if (/\.html?$/.test(fileName)) return 'html'
  if (/\.md$/.test(fileName)) return 'markdown'
  if (/\.go$/.test(fileName)) return 'go'
  if (/\.py$/.test(fileName)) return 'python'
  if (/\.rs$/.test(fileName)) return 'rust'
  return 'plaintext'
}

function joinPath(base: string, relative: string): string {
  // Normalize separators for Windows
  const normalized = relative.replace(/\//g, '\\').replace(/^\\/,'')
  return `${base.replace(/[\/\\]$/, '')}\\${normalized}`
}

function relativeProjectPath(filePath: string, projectPath: string): string {
  const normalizedFile = filePath.replace(/\//g, '\\')
  const normalizedProject = projectPath.replace(/[\/\\]$/, '').replace(/\//g, '\\')
  return normalizedFile.startsWith(normalizedProject)
    ? normalizedFile.slice(normalizedProject.length + 1)
    : normalizedFile.split('\\').pop() ?? ''
}

export function CodePreview({ filePath, projectPath, sessions, onClose }: CodePreviewProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<ViewTab>('edit')
  const [editContent, setEditContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [modifiedContent, setModifiedContent] = useState('')
  const [activeSessionId, setActiveSessionId] = useState<string>(sessions[0]?.id ?? '')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const activeSession = sessions.find(s => s.id === activeSessionId) ?? sessions[0]
  const relativePath = filePath && projectPath ? relativeProjectPath(filePath, projectPath) : null

  // Determine which workspace path to read from for the active session
  const workspaceFilePath = useCallback((): string | null => {
    if (!filePath || !projectPath || !activeSession) return null
    return joinPath(activeSession.workspacePath, relativePath ?? '')
  }, [activeSession, filePath, projectPath, relativePath])

  useEffect(() => {
    if (!activeSessionId && sessions[0]?.id) {
      setActiveSessionId(sessions[0].id)
    }
  }, [activeSessionId, sessions])

  useEffect(() => {
    if (!filePath) return
    let cancelled = false
    setLoading(true)
    setSaveError(null)
    
    async function fetchContents() {
      try {
        // Always load the file from the active session's workspace for editing
        const workspace = workspaceFilePath()
        const content = await window.sentinel.readFile(workspace ?? filePath!)
        if (cancelled) return
        setEditContent(content)

        // For diff, also load original from root project
        const rootContent = filePath ? await window.sentinel.readFile(filePath).catch(() => '') : ''
        if (cancelled) return
        setOriginalContent(rootContent)
        setModifiedContent(content)
      } catch {
        if (!cancelled) {
          setEditContent('// Could not read file — it may be binary or inaccessible.')
          setOriginalContent('')
          setModifiedContent('')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchContents()
    return () => { cancelled = true }
  }, [filePath, activeSessionId, workspaceFilePath])

  async function handleSave() {
    if (!activeSession || !relativePath) return
    setSaving(true)
    setSaveError(null)
    try {
      await window.sentinel.writeSessionFile(activeSession.id, relativePath, editContent)
      setModifiedContent(editContent)
    } catch (error: any) {
      setSaveError(error.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.code !== 'KeyS') return
      if (!filePath || !activeSession || !relativePath) return
      event.preventDefault()
      void handleSave()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [activeSession, editContent, filePath, relativePath])

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center bg-[#0d1117] border border-white/10">
        <div className="flex flex-col items-center gap-3 text-sentinel-mist">
          <FileCode2 className="h-10 w-10 opacity-30" />
          <p className="text-sm">Select a file from the sidebar to open it</p>
        </div>
      </div>
    )
  }

  const fileName = filePath.split(/[\/\\]/).pop() ?? 'File'
  const language = getLanguage(fileName)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0d1117]">
      {/* Editor Titlebar */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 bg-[#0d1117] px-3 py-1.5 gap-3">
        {/* Left: filename + session selector */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 text-xs text-sentinel-mist font-medium truncate">
            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-sentinel-ice" />
            <span className="truncate">{fileName}</span>
          </div>
          {sessions.length > 1 && (
            <select
              className="shrink-0 bg-black/40 border border-white/10 text-xs text-sentinel-mist px-2 py-0.5 outline-none focus:border-sentinel-accent/40"
              value={activeSessionId}
              onChange={(e) => setActiveSessionId(e.target.value)}
            >
              {sessions.map(s => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          )}
        </div>

        {/* Center: Tab switcher */}
        <div className="flex items-center shrink-0">
          <button
            className={`flex items-center gap-1.5 border-b-2 px-3 py-1 text-[11px] font-medium uppercase tracking-widest transition-colors ${
              activeTab === 'edit'
                ? 'border-sentinel-accent text-white'
                : 'border-transparent text-sentinel-mist hover:text-white'
            }`}
            onClick={() => setActiveTab('edit')}
          >
            <Code2 className="h-3 w-3" />
            Edit
          </button>
          <button
            className={`flex items-center gap-1.5 border-b-2 px-3 py-1 text-[11px] font-medium uppercase tracking-widest transition-colors ${
              activeTab === 'diff'
                ? 'border-emerald-400 text-white'
                : 'border-transparent text-sentinel-mist hover:text-white'
            }`}
            onClick={() => setActiveTab('diff')}
          >
            <Diff className="h-3 w-3" />
            Diff
          </button>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-2 shrink-0">
          {activeSession && (
            <div className="text-[10px] uppercase tracking-[0.2em] text-sentinel-mist">
              {activeSession.workspaceStrategy === 'sandbox-copy' ? 'sandbox' : 'worktree'}
            </div>
          )}
          {saveError && <span className="text-[10px] text-rose-300">{saveError}</span>}
          <button
            onClick={() => { void handleSave() }}
            className="inline-flex items-center gap-1.5 border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-sentinel-mist transition hover:border-sentinel-accent/40 hover:text-white disabled:opacity-40"
            disabled={!activeSession || !relativePath || saving}
            title="Save to session workspace"
          >
            <Save className="h-3 w-3" />
            {saving ? 'Saving' : 'Save'}
          </button>
          <button
            onClick={onClose}
            className="text-sentinel-mist/60 hover:text-white transition-colors"
            title="Close editor"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Editor Area */}
      <div className="relative flex-1 min-h-0">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0d1117]/80 text-xs text-sentinel-mist">
            Loading...
          </div>
        )}

        {/* Edit tab — always keep mounted to avoid blink, shown/hidden via CSS */}
        <div className={`h-full w-full absolute inset-0 ${activeTab === 'edit' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <Editor
            height="100%"
            language={language}
            theme="vs-dark"
            value={editContent}
            onChange={(val) => {
              const nextValue = val ?? ''
              setEditContent(nextValue)
              setModifiedContent(nextValue)
            }}
            options={{
              fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
              fontSize: 13,
              lineHeight: 1.6,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              renderWhitespace: 'none',
              padding: { top: 12, bottom: 12 }
            }}
          />
        </div>

        {/* Diff tab */}
        <div className={`h-full w-full absolute inset-0 ${activeTab === 'diff' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <DiffEditor
            height="100%"
            language={language}
            theme="vs-dark"
            original={originalContent}
            modified={modifiedContent}
            options={{
              readOnly: true,
              renderSideBySide: true,
              fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      </div>
    </div>
  )
}
