import {
  type BoardState,
  type ClaudeSession,
  emptyBoardState,
  type Project,
  type Terminal,
} from '@yardmaster/protocol';

// Synthetic sample data only.
const T0 = 1_760_000_000_000;

export function makeProject(id: string, name: string, accent = 0): Project {
  return {
    id,
    path: `/home/dev/${name}`,
    name,
    accent,
    source: 'editor',
    git: {
      branch: 'main',
      head: '0f1e2d3',
      detached: false,
      dirty: 0,
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      files: [],
      commits: [],
      updatedAt: T0,
    },
    createdAt: T0,
    lastActivityAt: null,
  };
}

export function makeSession(
  id: string,
  projectId: string,
  status: ClaudeSession['status'],
  title: string | null = null,
): ClaudeSession {
  return {
    id,
    origin: 'terminal',
    projectId,
    cwd: null,
    status,
    title,
    model: 'claude-sonnet',
    permissionMode: 'default',
    tokens: { input: 1200, output: 800, cacheRead: 10_000, cacheCreation: 400 },
    contextTokens: null,
    currentTool: null,
    todos: [],
    subagents: [],
    terminalId: null,
    claudePid: null,
    transcriptPath: null,
    lastAssistantText: 'Refactoring the cart totals.',
    startedAt: T0,
    updatedAt: T0,
    endedAt: null,
  };
}

export function makeTerminal(
  id: string,
  projectId: string,
  exitCode: number | null = null,
): Terminal {
  return {
    id,
    windowId: 'win-1',
    projectId,
    name: `shell-${id}`,
    shellPid: null,
    cwd: null,
    state: exitCode === null ? 'open' : 'closed',
    shellIntegration: true,
    active: false,
    exitCode,
    executionIds: [],
    stats: null,
    createdAt: T0,
    closedAt: null,
  };
}

/** Three projects: one waiting, one working, one idle with a crashed terminal. */
export function sampleBoard(): BoardState {
  const board = emptyBoardState();
  const projects = [
    makeProject('p-acme', 'acme-shop', 3),
    makeProject('p-orbit', 'orbit-api', 6),
    // Its terminal just crashed: recent activity keeps it on the active-only overview.
    { ...makeProject('p-zen', 'zen-notes', 8), lastActivityAt: Date.now() },
  ];
  for (const p of projects) board.projects[p.id] = p;
  const sessions = [
    makeSession('s-1', 'p-acme', { kind: 'waiting_permission', approvalId: null }, 'Checkout fix'),
    makeSession('s-2', 'p-orbit', { kind: 'working' }, 'Rate limiter'),
  ];
  for (const s of sessions) board.sessions[s.id] = s;
  const terminal = makeTerminal('t-1', 'p-zen', 1);
  board.terminals[terminal.id] = terminal;
  return board;
}
