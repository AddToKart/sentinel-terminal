import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  FolderRoot,
  GitBranch,
  RefreshCw
} from 'lucide-react'

import type { ProjectNode, ProjectState } from '@shared/types'

interface SidebarProps {
  project: ProjectState
  refreshing: boolean
  collapsed: boolean
  diffBadges: Record<string, string[]>
  onOpenProject: () => void
  onRefreshProject: () => void
  onToggleCollapse: () => void
}

interface FileContextMenuState {
  node: ProjectNode
  x: number
  y: number
}

function initialExpandedPaths(nodes: ProjectNode[]): Set<string> {
  return new Set(
    nodes
      .filter((node) => node.kind === 'directory')
      .slice(0, 6)
      .map((node) => node.path)
  )
}

function fileIcon(name: string): JSX.Element {
  if (/\.(tsx?|jsx?|py|go|rs|json|ya?ml|css|md|toml|html)$/i.test(name)) {
    return <FileCode2 className="h-4 w-4 text-sentinel-ice" />
  }

  return <FileText className="h-4 w-4 text-sentinel-mist" />
}

function renderDiffBadges(badges: string[]): JSX.Element | null {
  if (badges.length === 0) {
    return null
  }

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <span className="border border-sentinel-accent/40 bg-sentinel-accent/12 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-white">
        {badges[0]}
      </span>
      {badges.length > 1 && (
        <span className="border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.2em] text-sentinel-mist">
          +{badges.length - 1}
        </span>
      )}
    </div>
  )
}

function TreeNode({
  depth,
  expandedPaths,
  diffBadges,
  node,
  toggle,
  onFileContextMenu
}: {
  node: ProjectNode
  depth: number
  expandedPaths: Set<string>
  diffBadges: Record<string, string[]>
  toggle: (path: string) => void
  onFileContextMenu: (event: MouseEvent<HTMLButtonElement>, node: ProjectNode) => void
}): JSX.Element {
  const isDirectory = node.kind === 'directory'
  const expanded = expandedPaths.has(node.path)
  const hasChildren = Boolean(node.children && node.children.length > 0)
  const badges = node.kind === 'file' ? diffBadges[node.path] ?? [] : []
  const isModified = badges.length > 0

  return (
    <div className="space-y-1">
      <button
        className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition ${
          isModified
            ? 'bg-sentinel-accent/10 text-white'
            : 'text-sentinel-mist hover:bg-white/[0.05] hover:text-white'
        }`}
        onClick={() => {
          if (isDirectory) {
            toggle(node.path)
          }
        }}
        onContextMenu={(event) => {
          if (!isDirectory) {
            onFileContextMenu(event, node)
          }
        }}
        style={{ paddingLeft: 10 + depth * 14 }}
        title={node.path}
        type="button"
      >
        {isDirectory ? (
          <>
            {hasChildren ? (
              expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />
            ) : (
              <span className="inline-block h-4 w-4 shrink-0" />
            )}
            {expanded ? (
              <FolderOpen className="h-4 w-4 shrink-0 text-sentinel-accent" />
            ) : (
              <Folder className="h-4 w-4 shrink-0 text-sentinel-accent" />
            )}
          </>
        ) : (
          <>
            <span className="inline-block h-4 w-4 shrink-0" />
            {fileIcon(node.name)}
          </>
        )}

        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {renderDiffBadges(badges)}
      </button>

      {isDirectory && expanded && hasChildren && (
        <div className="space-y-1">
          {node.children?.map((child) => (
            <TreeNode
              key={child.path}
              depth={depth + 1}
              diffBadges={diffBadges}
              expandedPaths={expandedPaths}
              node={child}
              onFileContextMenu={onFileContextMenu}
              toggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function Sidebar({
  project,
  refreshing,
  collapsed,
  diffBadges,
  onOpenProject,
  onRefreshProject,
  onToggleCollapse
}: SidebarProps): JSX.Element {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null)

  useEffect(() => {
    setExpandedPaths(initialExpandedPaths(project.tree))
  }, [project.path, project.tree])

  useEffect(() => {
    function closeContextMenu(): void {
      setContextMenu(null)
    }

    function handleEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        closeContextMenu()
      }
    }

    window.addEventListener('pointerdown', closeContextMenu)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('pointerdown', closeContextMenu)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [])

  function toggle(pathValue: string): void {
    setExpandedPaths((current) => {
      const next = new Set(current)

      if (next.has(pathValue)) {
        next.delete(pathValue)
      } else {
        next.add(pathValue)
      }

      return next
    })
  }

  function handleFileContextMenu(event: MouseEvent<HTMLButtonElement>, node: ProjectNode): void {
    event.preventDefault()
    event.stopPropagation()

    setContextMenu({
      node,
      x: event.clientX,
      y: event.clientY
    })
  }

  async function revealInExplorer(filePath: string): Promise<void> {
    setContextMenu(null)
    await window.sentinel.revealInFileExplorer(filePath)
  }

  async function openInSystemEditor(filePath: string): Promise<void> {
    setContextMenu(null)
    await window.sentinel.openInSystemEditor(filePath)
  }

  if (collapsed) {
    return (
      <aside className="flex h-full min-h-0 flex-col items-center overflow-hidden border-r border-white/10 bg-sentinel-ink/90 px-3 pb-4 pt-10 backdrop-blur-xl">
        <div className="flex flex-col items-center gap-3">
          <button
            className="inline-flex h-10 w-10 items-center justify-center border border-white/10 bg-white/[0.04] text-white transition hover:border-sentinel-accent/40 hover:bg-sentinel-accent/10"
            onClick={onToggleCollapse}
            title="Expand sidebar"
            type="button"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          <div className="inline-flex h-10 w-10 items-center justify-center border border-white/10 bg-white text-sm font-semibold uppercase tracking-[0.28em] text-sentinel-ink">
            {project.name?.slice(0, 1) || 'S'}
          </div>

          <button
            className="inline-flex h-10 w-10 items-center justify-center border border-white/10 bg-white/[0.04] text-white transition hover:border-sentinel-accent/40 hover:bg-sentinel-accent/10"
            onClick={onOpenProject}
            title="Open project"
            type="button"
          >
            <FolderOpen className="h-4 w-4" />
          </button>

          <button
            className="inline-flex h-10 w-10 items-center justify-center border border-white/10 bg-white/[0.04] text-white transition hover:border-sentinel-accent/40 hover:bg-sentinel-accent/10"
            onClick={onRefreshProject}
            title="Refresh tree"
            type="button"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="relative flex h-full min-h-0 flex-col overflow-hidden border-r border-white/10 bg-sentinel-ink/80 px-4 pb-4 pt-10 backdrop-blur-xl transition-[padding] duration-300">
      <div className="shrink-0 space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.28em] text-sentinel-mist">Workspace</div>
            <div className="mt-2 text-2xl font-semibold tracking-tight text-white">Sentinel</div>
          </div>

          <button
            className="inline-flex h-10 w-10 items-center justify-center border border-white/10 bg-white/[0.04] text-white transition hover:border-sentinel-accent/40 hover:bg-sentinel-accent/10"
            onClick={onToggleCollapse}
            title="Collapse sidebar"
            type="button"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </div>

        <div className="panel-muted space-y-4 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-sentinel-mist">
                <FolderRoot className="h-3.5 w-3.5" />
                Project
              </div>
              <div className="text-lg font-medium text-white">{project.name || 'No repository selected'}</div>
            </div>

            <button
              className="inline-flex h-10 w-10 items-center justify-center border border-white/10 bg-white/[0.05] text-sentinel-mist transition hover:border-sentinel-accent/40 hover:bg-sentinel-accent/10 hover:text-white"
              onClick={onRefreshProject}
              title="Refresh tree"
              type="button"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {project.path && (
            <div className="space-y-2">
              {project.branch && (
                <div className="inline-flex items-center gap-2 border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-sentinel-mist">
                  <GitBranch className="h-3.5 w-3.5" />
                  {project.branch}
                </div>
              )}

              <div className="border border-white/10 bg-black/20 px-3 py-3 text-xs leading-5 text-sentinel-mist">
                {project.path}
              </div>
            </div>
          )}

          <button
            className="inline-flex w-full items-center justify-center gap-2 border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white transition hover:border-sentinel-accent/40 hover:bg-sentinel-accent/10"
            onClick={onOpenProject}
            type="button"
          >
            <FolderOpen className="h-4 w-4" />
            {project.path ? 'Open Another Project' : 'Open Project'}
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-[0.24em] text-sentinel-mist">Project Tree</div>
          {project.tree.length > 0 && (
            <div className="border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-sentinel-mist">
              live diff badges
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 min-h-0 flex-1 overflow-auto pr-1">
        {project.tree.length === 0 ? (
          <div className="border border-dashed border-white/10 bg-white/[0.03] p-4 text-sm leading-6 text-sentinel-mist">
            Select a repository to browse files and start worktree-backed agent sessions.
          </div>
        ) : (
          <div className="space-y-1">
            {project.tree.map((node) => (
              <TreeNode
                key={node.path}
                depth={0}
                diffBadges={diffBadges}
                expandedPaths={expandedPaths}
                node={node}
                onFileContextMenu={handleFileContextMenu}
                toggle={toggle}
              />
            ))}
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          className="fixed z-50 min-w-[220px] border border-white/10 bg-[#0b1219] p-1 shadow-terminal"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white transition hover:bg-white/[0.06]"
            onClick={() => {
              void revealInExplorer(contextMenu.node.path)
            }}
            type="button"
          >
            <span>Reveal in File Explorer</span>
            <span className="font-mono text-[11px] text-sentinel-mist">explorer</span>
          </button>
          <button
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white transition hover:bg-white/[0.06]"
            onClick={() => {
              void openInSystemEditor(contextMenu.node.path)
            }}
            type="button"
          >
            <span>Open in System Editor</span>
            <span className="font-mono text-[11px] text-sentinel-mist">system</span>
          </button>
        </div>
      )}
    </aside>
  )
}
