import type {
  Approval,
  BoardState,
  ClaudeSession,
  EditorWindow,
  Execution,
  PortBinding,
  Project,
  Terminal,
} from './domain.js';

// Synthetic sample data only.
export const T0 = 1_760_000_000_000;

export const project: Project = {
  id: 'a1b2c3d4e5f6',
  path: '/home/dev/acme-shop',
  name: 'acme-shop',
  accent: 3,
  source: 'editor',
  git: {
    branch: 'feat/checkout',
    head: '0f1e2d3',
    detached: false,
    dirty: 3,
    upstream: 'origin/feat/checkout',
    ahead: 1,
    behind: 0,
    files: [
      { path: 'src/cart.ts', origPath: null, status: 'modified', staged: true, unstaged: false },
      {
        path: 'src/pay.ts',
        origPath: 'src/payment.ts',
        status: 'renamed',
        staged: true,
        unstaged: true,
      },
      { path: 'notes.md', origPath: null, status: 'untracked', staged: false, unstaged: true },
    ],
    commits: [{ hash: '0f1e2d3', author: 'Dev One', at: T0, subject: 'Add cart totals' }],
    updatedAt: T0,
  },
  createdAt: T0,
  lastActivityAt: null,
};

export const editorWindow: EditorWindow = {
  id: 'win-1',
  appName: 'Cursor',
  appVersion: '3.5.0',
  extensionVersion: '0.1.0',
  workspaceFolders: ['/home/dev/acme-shop'],
  projectIds: [project.id],
  capabilities: { shellExecution: true },
  connectedAt: T0,
  lastSeenAt: T0 + 1000,
};

export const terminal: Terminal = {
  id: 'term-1',
  windowId: editorWindow.id,
  projectId: project.id,
  name: 'backend',
  shellPid: 4242,
  cwd: '/home/dev/acme-shop',
  state: 'open',
  shellIntegration: true,
  active: true,
  exitCode: null,
  executionIds: ['exec-1'],
  stats: { pid: 4242, cpu: 12.5, rssBytes: 52_428_800, processCount: 3, sampledAt: T0 },
  createdAt: T0,
  closedAt: null,
};

export const execution: Execution = {
  id: 'exec-1',
  terminalId: terminal.id,
  commandLine: 'pnpm dev',
  confidence: 'high',
  cwd: '/home/dev/acme-shop',
  startedAt: T0,
  endedAt: null,
  exitCode: null,
  outputBytes: 1024,
  truncated: false,
  interactive: false,
};

export const session: ClaudeSession = {
  id: '3f6c1a2e-8b7d-4c5e-9a10-2b3c4d5e6f70',
  origin: 'terminal',
  projectId: project.id,
  cwd: '/home/dev/acme-shop',
  status: { kind: 'tool', tool: 'Edit', toolUseId: 'toolu_01' },
  title: 'Refactor cart totals',
  model: 'claude-sonnet-5-5',
  permissionMode: 'default',
  tokens: { input: 1200, output: 340, cacheRead: 9000, cacheCreation: 500 },
  contextTokens: 12_400,
  currentTool: {
    id: 'toolu_01',
    sessionId: '3f6c1a2e-8b7d-4c5e-9a10-2b3c4d5e6f70',
    tool: 'Edit',
    family: 'edit',
    summary: 'src/cart.ts',
    startedAt: T0,
    endedAt: null,
    status: 'running',
  },
  todos: [{ content: 'Update totals', status: 'in_progress', activeForm: 'Updating totals' }],
  subagents: [],
  terminalId: terminal.id,
  claudePid: 5151,
  transcriptPath: '/home/dev/.claude/projects/-home-dev-acme-shop/3f6c1a2e.jsonl',
  lastAssistantText: 'Refactoring the cart totals…',
  startedAt: T0,
  updatedAt: T0 + 500,
  endedAt: null,
};

export const approval: Approval = {
  id: 'appr-1',
  sessionId: session.id,
  source: 'sdk',
  tool: 'Bash',
  input: { command: 'pnpm test' },
  toolUseId: 'toolu_02',
  createdAt: T0,
  expiresAt: T0 + 120_000,
  state: 'pending',
  decidedAt: null,
  reason: null,
};

export const port: PortBinding = {
  id: '127.0.0.1:3000',
  port: 3000,
  address: '127.0.0.1',
  pid: 4243,
  command: 'node',
  terminalId: terminal.id,
  projectId: project.id,
  firstSeenAt: T0,
};

export const board: BoardState = {
  projects: { [project.id]: project },
  windows: { [editorWindow.id]: editorWindow },
  terminals: { [terminal.id]: terminal },
  executions: { [execution.id]: execution },
  sessions: { [session.id]: session },
  approvals: { [approval.id]: approval },
  ports: { [port.id]: port },
};
