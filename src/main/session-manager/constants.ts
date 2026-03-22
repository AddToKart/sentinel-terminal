export const TREE_DEPTH = 3
export const TREE_ENTRY_LIMIT = 28
export const METRIC_INTERVAL_MS = 1000
export const RUN_COMMAND_TIMEOUT_MS = 30_000
export const CLOSE_TIMEOUT_MS = 4_000

export const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.venv',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '__pycache__'
])

export const SANDBOX_LINK_DIRECTORIES = new Set([
  'node_modules',
  '.venv',
  'venv',
  '.tox',
  '.yarn',
  '.pnpm-store'
])
