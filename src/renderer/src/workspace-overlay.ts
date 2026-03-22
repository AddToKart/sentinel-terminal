import type { IdeTerminalState, ProjectNode, SessionSummary } from '@shared/types'

export interface SelectedFileEntry {
  projectPath: string
  workspacePath?: string
}

export interface WorkspaceOverlayFile {
  projectPath: string
  relativePath: string
  workspaceRoot: string
  workspacePath: string
  source: 'ide' | 'session'
  sessionId?: string
}

export interface SidebarTreeNode {
  name: string
  path: string
  kind: 'file' | 'directory'
  targetPath: string
  children?: SidebarTreeNode[]
  virtual?: boolean
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

function normalizeLookupPath(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/[\\]+/g, '\\').replace(/[\\]+$/, '').toLowerCase()
}

export function joinAbsolutePath(rootPath: string, relativePath: string): string {
  const normalizedRoot = rootPath.replace(/[\/\\]+$/, '')
  const normalizedRelativePath = normalizeRelativePath(relativePath).replace(/\//g, '\\')

  return normalizedRelativePath
    ? `${normalizedRoot}\\${normalizedRelativePath}`
    : normalizedRoot
}

export function collectProjectPaths(nodes: ProjectNode[]): Set<string> {
  const paths = new Set<string>()

  function visit(node: ProjectNode): void {
    paths.add(node.path)
    node.children?.forEach(visit)
  }

  nodes.forEach(visit)
  return paths
}

function cloneProjectNode(node: ProjectNode): SidebarTreeNode {
  return {
    name: node.name,
    path: node.path,
    kind: node.kind,
    targetPath: node.path,
    virtual: false,
    children: node.children?.map(cloneProjectNode)
  }
}

function sortTreeNodes(nodes: SidebarTreeNode[]): SidebarTreeNode[] {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1
    }

    return left.name.localeCompare(right.name)
  })

  for (const node of nodes) {
    if (node.children) {
      sortTreeNodes(node.children)
    }
  }

  return nodes
}

function indexSidebarTree(nodes: SidebarTreeNode[], index = new Map<string, SidebarTreeNode>()): Map<string, SidebarTreeNode> {
  for (const node of nodes) {
    index.set(normalizeLookupPath(node.path), node)
    if (node.children) {
      indexSidebarTree(node.children, index)
    }
  }

  return index
}

function orderedSessions(
  sessions: SessionSummary[],
  maximizedSessionId: string | null
): SessionSummary[] {
  return [...sessions].sort((left, right) => {
    if (left.id === maximizedSessionId) return -1
    if (right.id === maximizedSessionId) return 1
    return right.createdAt - left.createdAt
  })
}

export function buildWorkspaceOverlayFiles(params: {
  projectPath?: string
  ideTerminalState: IdeTerminalState
  sessions: SessionSummary[]
  sessionDiffs: Record<string, string[]>
  globalMode: 'multiplex' | 'ide'
  maximizedSessionId: string | null
}): WorkspaceOverlayFile[] {
  const { projectPath, ideTerminalState, sessions, sessionDiffs, globalMode, maximizedSessionId } = params
  if (!projectPath) {
    return []
  }

  const normalizedProjectPath = projectPath
  const overlays = new Map<string, WorkspaceOverlayFile>()

  function registerOverlay(
    relativePath: string,
    workspaceRoot: string | undefined,
    source: 'ide' | 'session',
    sessionId?: string
  ): void {
    if (!workspaceRoot) {
      return
    }

    const normalizedRelativePath = normalizeRelativePath(relativePath)
    if (!normalizedRelativePath) {
      return
    }

    const projectFilePath = joinAbsolutePath(normalizedProjectPath, normalizedRelativePath)
    const lookupKey = normalizeLookupPath(projectFilePath)
    if (overlays.has(lookupKey)) {
      return
    }

    overlays.set(lookupKey, {
      projectPath: projectFilePath,
      relativePath: normalizedRelativePath,
      workspaceRoot,
      workspacePath: joinAbsolutePath(workspaceRoot, normalizedRelativePath),
      source,
      sessionId
    })
  }

  if (globalMode === 'ide') {
    ideTerminalState.modifiedPaths.forEach((relativePath) => {
      registerOverlay(relativePath, ideTerminalState.workspacePath, 'ide')
    })
  }

  for (const session of orderedSessions(sessions, maximizedSessionId)) {
    for (const relativePath of sessionDiffs[session.id] ?? []) {
      registerOverlay(relativePath, session.workspacePath, 'session', session.id)
    }
  }

  if (globalMode !== 'ide') {
    ideTerminalState.modifiedPaths.forEach((relativePath) => {
      registerOverlay(relativePath, ideTerminalState.workspacePath, 'ide')
    })
  }

  return [...overlays.values()]
}

export function buildSidebarTree(
  projectPath: string | undefined,
  projectTree: ProjectNode[],
  overlayFiles: WorkspaceOverlayFile[]
): SidebarTreeNode[] {
  const rootNodes = projectTree.map(cloneProjectNode)
  if (!projectPath || overlayFiles.length === 0) {
    return rootNodes
  }

  const normalizedProjectRoot = projectPath.replace(/[\/\\]+$/, '')
  const nodeIndex = indexSidebarTree(rootNodes)

  for (const overlay of overlayFiles) {
    const pathSegments = overlay.relativePath.split('/').filter(Boolean)
    if (pathSegments.length === 0) {
      continue
    }

    let currentChildren = rootNodes
    const accumulatedSegments: string[] = []

    for (const segment of pathSegments.slice(0, -1)) {
      accumulatedSegments.push(segment)
      const projectDirectoryPath = joinAbsolutePath(normalizedProjectRoot, accumulatedSegments.join('/'))
      const directoryLookupKey = normalizeLookupPath(projectDirectoryPath)

      let directoryNode = nodeIndex.get(directoryLookupKey)
      if (!directoryNode) {
        directoryNode = {
          name: segment,
          path: projectDirectoryPath,
          targetPath: joinAbsolutePath(overlay.workspaceRoot, accumulatedSegments.join('/')),
          kind: 'directory',
          children: [],
          virtual: true
        }
        currentChildren.push(directoryNode)
        nodeIndex.set(directoryLookupKey, directoryNode)
      }

      directoryNode.targetPath = joinAbsolutePath(overlay.workspaceRoot, accumulatedSegments.join('/'))
      directoryNode.children ??= []
      currentChildren = directoryNode.children
    }

    const fileName = pathSegments[pathSegments.length - 1]
    const projectFilePath = overlay.projectPath
    const fileLookupKey = normalizeLookupPath(projectFilePath)
    const existingNode = nodeIndex.get(fileLookupKey)

    if (existingNode) {
      existingNode.targetPath = overlay.workspacePath
      continue
    }

    const fileNode: SidebarTreeNode = {
      name: fileName,
      path: projectFilePath,
      targetPath: overlay.workspacePath,
      kind: 'file',
      virtual: true
    }
    currentChildren.push(fileNode)
    nodeIndex.set(fileLookupKey, fileNode)
  }

  return sortTreeNodes(rootNodes)
}

export function collectAutoExpandedPaths(
  projectPath: string | undefined,
  projectTree: ProjectNode[],
  overlayFiles: WorkspaceOverlayFile[]
): Set<string> {
  const expandedPaths = new Set(
    projectTree
      .filter((node) => node.kind === 'directory')
      .slice(0, 6)
      .map((node) => node.path)
  )

  if (!projectPath) {
    return expandedPaths
  }

  for (const overlay of overlayFiles) {
    const pathSegments = overlay.relativePath.split('/').filter(Boolean)
    const directorySegments = pathSegments.slice(0, -1)
    for (let index = 0; index < directorySegments.length; index += 1) {
      expandedPaths.add(joinAbsolutePath(projectPath, directorySegments.slice(0, index + 1).join('/')))
    }
  }

  return expandedPaths
}
