# Sentinel

Sentinel is a Windows-focused Electron IDE for running multiple AI agent terminals in parallel. Each agent session is backed by a dedicated Git worktree in a temporary directory, which keeps file changes isolated while sharing the same repository history.

## Stack

- Electron for the Windows desktop shell and IPC bridge
- React + Tailwind CSS for the renderer
- xterm.js for live terminal tiles
- node-pty + ConPTY for multiplexed PowerShell sessions

## Scripts

```bash
npm install
npm run dev
npm run build
```

## Workflow

1. Open a Git repository from the sidebar.
2. Click the `+ New Agent` control to create an isolated worktree-backed PowerShell session.
3. Launch tools like `claude`, `aider`, or custom scripts inside any tile.
4. Close a session to kill its process tree and clean up the worktree when it is safe to remove.

