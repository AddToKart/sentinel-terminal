# Sentinel

Sentinel is a Windows-focused Electron IDE for running multiple AI agent terminals in parallel. Each agent session is backed by a dedicated Git worktree or sandbox copy in a temporary directory, keeping file changes isolated while sharing the same repository history.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Requirements](#requirements)
- [Installation](#installation)
- [Development](#development)
- [Building](#building)
- [Architecture](#architecture)
- [Usage Guide](#usage-guide)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Configuration](#configuration)

## Overview

Sentinel provides a workspace orchestration layer for AI coding agents like Claude, Aider, or custom scripts. Each session runs in an isolated environment with:

- **Sandbox Copy Mode**: Duplicates the project tree to a temporary directory with shared `node_modules` via symlinks
- **Git Worktree Mode**: Creates isolated Git worktrees for branch-based session isolation

Sessions are fully isolated with dedicated PowerShell processes, real-time metrics monitoring, and workspace diff tracking.

## Features

- **Parallel Agent Sessions**: Run multiple AI agent terminals simultaneously with isolated workspaces
- **Workspace Isolation**: Choose between sandbox-copy or Git worktree strategies per session
- **Real-time Metrics**: Monitor CPU, memory, thread count, and process count per session
- **File Change Tracking**: Automatic detection of modified files with diff visualization
- **IDE Mode**: Integrated file editor with terminal panel for direct code editing
- **Multiplex Mode**: Grid layout for managing multiple agent sessions side-by-side
- **Command History**: Track all interactive and startup commands per session
- **Activity Logging**: Audit trail for Git and workspace operations
- **Session Management**: Apply, commit, or discard changes from any session
- **Process Cleanup**: Automatic termination of session process trees on close

## Tech Stack

### Main Process
- **Electron** (v31): Windows desktop shell with IPC bridge
- **node-pty** (v1.0): PTY spawning for PowerShell sessions
- **ConPTY**: Windows console host API for terminal multiplexing

### Renderer Process
- **React** (v18.3): UI component framework
- **TypeScript** (v5.7): Type-safe development
- **Vite** (v5.4): Build tool and dev server
- **Tailwind CSS** (v3.4): Utility-first styling
- **xterm.js** (v6.0): Terminal emulator
- **Monaco Editor**: Code editor component
- **Lucide React**: Icon library
- **react-resizable-panels**: Resizable layout panels

## Requirements

- **OS**: Windows 10/11 (Build 17763+ recommended for ConPTY)
- **Node.js**: v20.0.0 or higher
- **Git**: Required for Git worktree mode
- **PowerShell**: Default shell for all sessions

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd sentinel

# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## Development

### Available Scripts

```bash
npm run dev        # Start Electron dev server with hot reload
npm run build      # Build production bundles
npm run preview    # Preview production build
npm run typecheck  # Run TypeScript type checking
```

### IDE Setup

Sentinel uses VS Code with the following configuration:
- TypeScript 5.7+
- ESLint (recommended)
- Tailwind CSS IntelliSense

## Architecture

### Process Model

```
┌─────────────────────────────────────────────────────────────┐
│                     Electron Main Process                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                  SessionManager                         │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │  │
│  │  │WorkspaceSvc  │  │ProcessSvc    │  │IdeService    │  │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                  │
│              ┌─────────────┼─────────────┐                   │
│              │             │             │                   │
│         ┌────▼────┐  ┌────▼────┐  ┌────▼────┐              │
│         │ PTY 1   │  │ PTY 2   │  │ PTY N   │              │
│         │(Session)│  │(Session)│  │(Session)│              │
│         └─────────┘  └─────────┘  └─────────┘              │
└─────────────────────────────────────────────────────────────┘
                            │ IPC Bridge
┌─────────────────────────────────────────────────────────────┐
│                   Electron Renderer Process                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Sidebar    │  │  Dashboard  │  │  IDE Panel          │  │
│  │  (Tree)     │  │  (Grid)     │  │  (Editor+Terminal)  │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Core Services

#### SessionManager (`src/main/session-manager/SessionManager.ts`)
Central orchestrator for all session lifecycle operations:
- Bootstrap and initialization
- Session creation/closure
- Metrics collection
- Event emission to renderer

#### WorkspaceService (`src/main/session-manager/WorkspaceService.ts`)
Handles workspace isolation strategies:
- Sandbox copy creation and synchronization
- Git worktree management
- File operations and diff detection

#### ProcessService (`src/main/session-manager/ProcessService.ts`)
Process tree management:
- PID tracking per session
- Resource metrics via `pidusage`
- Graceful process termination

#### IdeService (`src/main/session-manager/IdeService.ts`)
IDE-mode terminal and file operations:
- Project-level terminal
- File read/write
- Workspace change application

## Usage Guide

### Opening a Project

1. Click **Open Repository** in the header or sidebar
2. Select a Git repository or plain folder
3. Project tree loads in the sidebar with file change indicators

### Creating Agent Sessions

1. Click **+ New Agent** in the header
2. Choose workspace strategy (set default in sidebar):
   - **Sandbox Copy**: Fast, works with any folder, shares `node_modules`
   - **Git Worktree**: Git-native, branch-based isolation
3. Session tile appears in the dashboard with live terminal

### Session Operations

Each session tile provides:
- **Terminal**: Interactive PowerShell with xterm.js
- **Command History**: View all executed commands
- **File Diffs**: See modified files with change badges
- **Metrics**: Real-time CPU/memory/process stats
- **Actions**:
  - Apply changes to main project
  - Commit session (Git worktree mode)
  - Discard changes
  - Open in file explorer
  - Open in system editor

### IDE Mode

Switch to IDE mode for integrated development:
- Split view: Code editor (top) + Terminal (bottom)
- Click files in sidebar to edit
- Terminal runs at project root
- Apply changes directly from editor

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Open global action bar |
| `Ctrl+\`` | Toggle console drawer |
| `Ctrl+Shift+P` | Command palette (Monaco) |

## API Reference

### IPC Channels (Main ↔ Renderer)

All IPC is exposed via the `window.sentinel` bridge in the renderer.

#### Session Management

```typescript
// Create a new session
await sentinel.createSession({
  label?: string,
  startupCommand?: string,
  cols?: number,
  rows?: number,
  workspaceStrategy?: 'sandbox-copy' | 'git-worktree'
})

// Close a session
await sentinel.closeSession(sessionId: string)

// Resize terminal
await sentinel.resizeSession(sessionId, cols, rows)

// Send input
await sentinel.sendInput(sessionId, data)
```

#### File Operations

```typescript
// Read file
const content = await sentinel.readFile(filePath)

// Write to session workspace
await sentinel.writeSessionFile(sessionId, relativePath, content)

// Get file diff
const diff = await sentinel.readFileDiff(sessionId, filePath)

// Apply session changes
const result = await sentinel.applySession(sessionId)

// Commit (Git worktree mode)
await sentinel.commitSession(sessionId, message)

// Discard changes
await sentinel.discardSessionChanges(sessionId)
```

#### Project Management

```typescript
// Open project dialog
const project = await sentinel.selectProject()

// Refresh project tree
const project = await sentinel.refreshProject()

// Bootstrap (get initial state)
const payload = await sentinel.bootstrap()
```

#### IDE Terminal

```typescript
// Ensure IDE terminal exists
const state = await sentinel.ensureIdeTerminal()

// Resize
await sentinel.resizeIdeTerminal(cols, rows)

// Send input
await sentinel.sendIdeTerminalInput(data)

// Write file
await sentinel.writeIdeFile(relativePath, content)

// Apply workspace changes
const result = await sentinel.applyIdeWorkspace()
```

#### Event Listeners

```typescript
// Session output (terminal data)
const unsub = sentinel.onSessionOutput((event) => {
  console.log(`Session ${event.sessionId}: ${event.data}`)
})

// Session state changes
sentinel.onSessionState((session) => { ... })

// Metrics updates
sentinel.onSessionMetrics((payload) => { ... })

// Command history
sentinel.onSessionHistory((payload) => { ... })

// File diffs
sentinel.onSessionDiff((payload) => { ... })

// Workspace state
sentinel.onWorkspaceState((summary) => { ... })

// Activity log
sentinel.onActivityLog((entry) => { ... })

// Cleanup listener
unsub()
```

### Type Definitions

Key types are defined in `src/shared/types.ts`:

```typescript
type SessionStatus = 'starting' | 'ready' | 'closing' | 'closed' | 'error'
type SessionWorkspaceStrategy = 'sandbox-copy' | 'git-worktree'

interface SessionSummary {
  id: string
  label: string
  projectRoot: string
  cwd: string
  workspacePath: string
  workspaceStrategy: SessionWorkspaceStrategy
  branchName?: string
  status: SessionStatus
  cleanupState: CleanupState
  shell: string
  pid?: number
  createdAt: number
  startupCommand?: string
  exitCode?: number | null
  error?: string
  metrics: ProcessMetrics
}

interface ProcessMetrics {
  cpuPercent: number
  memoryMb: number
  threadCount: number
  handleCount: number
  processCount: number
}
```

## Project Structure

```
sentinel/
├── src/
│   ├── main/                      # Electron main process
│   │   ├── index.ts               # Entry point, IPC registration
│   │   └── session-manager/       # Core session orchestration
│   │       ├── SessionManager.ts  # Central session coordinator
│   │       ├── WorkspaceService.ts# Workspace isolation logic
│   │       ├── ProcessService.ts  # Process tree management
│   │       ├── IdeService.ts      # IDE terminal & files
│   │       ├── sandbox-workspace.ts  # Sandbox copy implementation
│   │       ├── commands.ts        # Git/shell command helpers
│   │       ├── helpers.ts         # Utility functions
│   │       ├── types.ts           # Internal type definitions
│   │       └── constants.ts       # Configuration constants
│   │
│   ├── renderer/                  # React renderer process
│   │   └── src/
│   │       ├── App.tsx            # Root component
│   │       ├── main.tsx           # Entry point
│   │       ├── components/        # UI components
│   │       │   ├── AgentDashboard.tsx
│   │       │   ├── SessionTile.tsx
│   │       │   ├── Sidebar.tsx
│   │       │   ├── CodePreview.tsx
│   │       │   ├── IdeTerminalPanel.tsx
│   │       │   ├── StatusBar.tsx
│   │       │   ├── ConsoleDrawer.tsx
│   │       │   ├── GlobalActionBar.tsx
│   │       │   └── ActivityLog.tsx
│   │       ├── terminal-config.ts # xterm.js configuration
│   │       ├── terminal-stream.ts # Terminal output streams
│   │       └── workspace-overlay.ts # File tree overlay logic
│   │
│   ├── preload/                   # Electron preload script
│   │   └── index.ts               # Exposes sentinel API
│   │
│   └── shared/                    # Shared types
│       └── types.ts               # TypeScript interfaces
│
├── electron.vite.config.ts        # Vite build config
├── tailwind.config.ts             # Tailwind CSS config
├── tsconfig.json                  # TypeScript config
├── postcss.config.cjs             # PostCSS config
├── package.json                   # Dependencies & scripts
└── README.md                      # This file
```

## Configuration

### Environment Variables

Sentinel uses these environment variables in sessions:

| Variable | Description |
|----------|-------------|
| `SENTINEL_SESSION_ID` | Unique session identifier |
| `SENTINEL_WORKSPACE_PATH` | Session workspace directory |
| `SENTINEL_WORKSPACE_MODE` | `sandbox-copy` or `git-worktree` |
| `SENTINEL_BRANCH` | Git branch name (worktree mode) |
| `FORCE_COLOR` | Force color output in terminals |

### Constants

Key constants in `src/main/session-manager/constants.ts`:

```typescript
// Timing
METRIC_INTERVAL_MS = 1000      // Metrics refresh rate
CLOSE_TIMEOUT_MS = 5000        // Session close timeout
SESSION_PREFIX = 'sentinel-'   // Worktree/sandbox naming

// Ignored directories (not copied/linked)
IGNORED_DIRECTORIES = {
  '.git', 'node_modules', '.vscode', ...
}

// Shared directories (symlinked in sandbox mode)
SANDBOX_LINK_DIRECTORIES = {
  'node_modules', '.vscode', ...
}
```

### TypeScript Paths

```json
{
  "@renderer/*": "src/renderer/src/*",
  "@shared/*": "src/shared/*"
}
```

## License

Private project - All rights reserved

## Contributing

This is a private project. For questions or issues, contact the development team.
