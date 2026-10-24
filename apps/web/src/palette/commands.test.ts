import type { Approval, BoardState, EditorWindow, Execution, Project } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { makeSession, makeTerminal, sampleBoard } from '../test/board.js';
import {
  buildCommands,
  GROUP_LIMIT,
  type PaletteCommand,
  type PaletteContext,
  searchCommands,
} from './commands.js';

const T0 = 1_760_000_000_000;

const context = (over: Partial<PaletteContext> = {}): PaletteContext => ({
  projectId: null,
  motion: 'system',
  nextMotion: 'full',
  theme: 'dark',
  nextTheme: 'light',
  layout: 'minimal',
  railToggle: true,
  ...over,
});

function approval(id: string, sessionId: string, createdAt = T0): Approval {
  return {
    id,
    sessionId,
    source: 'hook',
    tool: 'Bash',
    input: { command: 'pnpm test' },
    toolUseId: null,
    createdAt,
    expiresAt: null,
    state: 'pending',
  } as Approval;
}

function execution(
  id: string,
  terminalId: string,
  commandLine: string,
  startedAt: number,
): Execution {
  return {
    id,
    terminalId,
    commandLine,
    confidence: 'high',
    cwd: null,
    startedAt,
    endedAt: startedAt + 1000,
    exitCode: 0,
    outputBytes: 10,
    truncated: false,
    interactive: false,
  };
}

/** sampleBoard plus approvals, terminals with history and an editor window. */
function board(): BoardState {
  const b = sampleBoard();
  b.approvals['ap-1'] = approval('ap-1', 's-1', T0 + 2);
  b.approvals['ap-2'] = approval('ap-2', 's-1', T0 + 1);
  b.approvals['ap-old'] = { ...approval('ap-old', 's-1'), state: 'allowed' };
  b.sessions['s-3'] = makeSession('s-3', 'p-acme', { kind: 'ended' }, 'Old spike');
  b.sessions['s-2'] = {
    ...makeSession('s-2', 'p-orbit', { kind: 'working' }, 'orbit-api-k2'),
    customTitle: 'Rate limiter',
    terminalId: 't-orbit',
  };
  b.terminals['t-acme'] = { ...makeTerminal('t-acme', 'p-acme'), name: 'next dev' };
  b.terminals['t-orbit'] = { ...makeTerminal('t-orbit', 'p-orbit'), name: 'claude' };
  b.executions['e-1'] = execution('e-1', 't-acme', 'pnpm test', T0 + 10);
  b.executions['e-2'] = execution('e-2', 't-acme', 'pnpm lint', T0 + 20);
  b.executions['e-3'] = execution('e-3', 't-orbit', 'cargo build', T0 + 30);
  b.windows['w-1'] = {
    id: 'w-1',
    appName: 'Cursor',
    appVersion: '1.0.0',
    extensionVersion: '0.0.0',
    workspaceFolders: [],
    projectIds: ['p-acme'],
    capabilities: { shellExecution: true },
    connectedAt: T0,
    lastSeenAt: T0,
  } satisfies EditorWindow;
  return b;
}

const byId = (commands: PaletteCommand[], id: string) => commands.find((c) => c.id === id);
const ids = (sections: ReturnType<typeof searchCommands>) =>
  sections.flatMap((s) => s.results.map((r) => r.command.id));

describe('buildCommands', () => {
  it('lists projects, live sessions and open terminals as destinations', () => {
    const commands = buildCommands(board(), context());
    expect(commands.filter((c) => c.group === 'Projects').map((c) => c.label)).toEqual([
      'acme-shop',
      'orbit-api',
      'zen-notes',
    ]);
    expect(byId(commands, 'project:p-acme')?.run).toEqual({ kind: 'navigate', href: '/p/p-acme' });
    expect(byId(commands, 'session:s-1')).toMatchObject({
      // Unnamed: "Claude", with its automatic title as context.
      label: 'Claude',
      hint: 'acme-shop · Waiting for approval · Checkout fix',
      tone: 'wait',
      run: { kind: 'navigate', href: '/p/p-acme/s/s-1' },
    });
    // Ended sessions only show up when searched for; closed terminals not at all.
    expect(byId(commands, 'session:s-3')?.searchOnly).toBe(true);
    expect(byId(commands, 'terminal:t-1')).toBeUndefined();
    expect(byId(commands, 'terminal:t-acme')?.run).toEqual({
      kind: 'navigate',
      href: '/p/p-acme',
      terminal: { projectId: 'p-acme', terminalId: 't-acme' },
    });
    // A Claude terminal goes by its session's name and opens in the stack, not the Claude column.
    expect(byId(commands, 'terminal:t-orbit')).toMatchObject({
      label: 'Rate limiter',
      hint: 'orbit-api · Claude terminal',
      icon: 'session',
      tone: 'work',
      run: {
        kind: 'navigate',
        href: '/p/p-orbit',
        terminal: { projectId: 'p-orbit', terminalId: 't-orbit' },
      },
    });
  });

  it('scopes project actions to the focused project', () => {
    const commands = buildCommands(board(), context({ projectId: 'p-acme' }));
    const actions = commands.filter((c) => c.group === 'Actions').map((c) => c.id);
    expect(actions).toContain('new-session:p-acme');
    expect(actions).not.toContain('new-session:p-orbit');
    expect(byId(commands, 'new-terminal:p-acme')).toMatchObject({
      label: 'New terminal in acme-shop…',
      run: { kind: 'newTerminal', projectId: 'p-acme' },
    });
    expect(actions).not.toContain('new-terminal:p-orbit');
    expect(byId(commands, 'approve-all:p-acme')).toMatchObject({
      label: 'Approve all waiting in acme-shop',
      hint: '2 requests',
      run: { kind: 'approveAll', approvalIds: ['ap-2', 'ap-1'] },
    });
    expect(byId(commands, 'rerun-last')).toMatchObject({
      label: 'Re-run last command',
      hint: 'pnpm lint',
      run: { kind: 'action', action: { kind: 'terminal.rerun', execId: 'e-2' } },
    });
    expect(byId(commands, 'open-editor:p-acme')).toMatchObject({
      label: 'Open acme-shop in Cursor',
      run: { action: { kind: 'project.openInEditor', projectId: 'p-acme' } },
    });
    expect(byId(commands, 'overview')?.shortcut).toEqual(['Esc']);
  });

  it('offers every project its actions from the overview, but only when searched', () => {
    const commands = buildCommands(board(), context());
    expect(byId(commands, 'new-session:p-orbit')?.searchOnly).toBe(true);
    expect(byId(commands, 'new-terminal:p-orbit')?.searchOnly).toBe(true);
    expect(byId(commands, 'open-editor:p-zen')?.searchOnly).toBe(true);
    expect(byId(commands, 'rerun-last')).toMatchObject({
      label: 'Re-run last command in orbit-api',
      run: { action: { execId: 'e-3' } },
    });
    expect(byId(commands, 'overview')).toBeUndefined();
  });

  it('closes and forgets projects, but never offers to close a closed one again', () => {
    const b = board();
    const focused = buildCommands(b, context({ projectId: 'p-acme' }));
    expect(byId(focused, 'close:p-acme')).toMatchObject({
      label: 'Close acme-shop',
      searchOnly: false,
      run: { kind: 'closeProject', projectId: 'p-acme', forget: false },
    });
    expect(byId(focused, 'forget:p-acme')).toMatchObject({
      label: 'Forget acme-shop',
      searchOnly: true,
      run: { kind: 'closeProject', projectId: 'p-acme', forget: true },
    });
    expect(byId(buildCommands(b, context()), 'close:p-orbit')?.searchOnly).toBe(true);

    b.projects['p-acme'] = { ...(b.projects['p-acme'] as Project), closedAt: 1 };
    const closed = buildCommands(b, context());
    expect(byId(closed, 'close:p-acme')).toBeUndefined();
    expect(byId(closed, 'project:p-acme')).toBeDefined();
  });

  it('interrupts board sessions through the SDK and terminal ones with Esc', () => {
    const b = board();
    b.sessions['s-4'] = {
      ...makeSession('s-4', 'p-zen', { kind: 'tool', tool: 'Bash', toolUseId: null } as never),
      origin: 'board',
    };
    const commands = buildCommands(b, context());
    expect(byId(commands, 'interrupt:s-4')?.run).toMatchObject({
      action: { kind: 'session.interrupt', sessionId: 's-4' },
    });
    expect(byId(commands, 'interrupt:s-2')?.run).toMatchObject({
      action: { kind: 'terminal.sendText', terminalId: 't-orbit', text: '\u001b', execute: false },
    });
    // Waiting sessions aren't busy, so there's nothing to interrupt.
    expect(byId(commands, 'interrupt:s-1')).toBeUndefined();
  });

  it('labels the motion and theme toggles with the next setting', () => {
    const commands = buildCommands(board(), context({ motion: 'full', nextMotion: 'reduced' }));
    expect(byId(commands, 'motion')).toMatchObject({
      label: 'Switch motion to Reduced',
      hint: 'Now Full',
      run: { kind: 'motion', next: 'reduced' },
    });
    expect(byId(commands, 'theme')?.run).toEqual({ kind: 'theme', next: 'light' });
    expect(byId(commands, 'rail')?.shortcut).toEqual(['[']);
    expect(byId(buildCommands(board(), context({ railToggle: false })), 'rail')).toBeUndefined();
  });

  it('offers every layout with its shortcut, the current one only when searched', () => {
    const commands = buildCommands(board(), context({ layout: 'office' }));
    expect(byId(commands, 'layout:grid')).toMatchObject({
      label: 'Layout: Grid',
      shortcut: ['⌥', '3'],
      run: { kind: 'layout', next: 'grid' },
    });
    expect(byId(commands, 'layout:office')).toMatchObject({ hint: 'Current', searchOnly: true });
    const found = searchCommands(commands, 'layout retro').flatMap((s) => s.results);
    expect(found[0]?.command.id).toBe('layout:retro');
  });

  it('opens the project picker, with the platform shortcut', () => {
    const open = byId(buildCommands(board(), context({ mac: true })), 'open-project');
    expect(open).toMatchObject({ label: 'Open project…', shortcut: ['⌘', 'O'] });
    expect(open?.run).toEqual({ kind: 'openProject' });
    expect(byId(buildCommands(board(), context()), 'open-project')?.shortcut).toEqual([
      'Ctrl',
      'O',
    ]);
  });

  it('skips interactive and empty commands when re-running', () => {
    const b = board();
    b.executions['e-4'] = { ...execution('e-4', 't-acme', 'htop', T0 + 99), interactive: true };
    b.executions['e-5'] = execution('e-5', 't-acme', '  ', T0 + 100);
    const rerun = byId(buildCommands(b, context({ projectId: 'p-acme' })), 'rerun-last');
    expect(rerun?.hint).toBe('pnpm lint');
  });
});

describe('searchCommands', () => {
  const commands = buildCommands(board(), context());

  it('browses everything but search-only items in group order', () => {
    const sections = searchCommands(commands, '');
    expect(sections.map((s) => s.group)).toEqual(['Projects', 'Sessions', 'Terminals', 'Actions']);
    expect(ids(sections)).not.toContain('session:s-3');
    expect(ids(sections)).not.toContain('new-session:p-acme');
  });

  it('ranks label matches first and highlights them', () => {
    const sections = searchCommands(commands, 'orbit');
    expect(sections[0]?.group).toBe('Projects');
    const first = sections[0]?.results[0];
    expect(first?.command.id).toBe('project:p-orbit');
    expect(first?.indices).toEqual([0, 1, 2, 3, 4]);
    // Actions for other projects surface once searched.
    expect(ids(sections)).toContain('new-session:p-orbit');
  });

  it('matches hints without highlighting them', () => {
    const sections = searchCommands(commands, 'cargo');
    const rerun = sections.flatMap((s) => s.results).find((r) => r.command.id === 'rerun-last');
    expect(rerun?.indices).toEqual([]);
  });

  it('finds ended sessions by name', () => {
    expect(ids(searchCommands(commands, 'old spike'))).toContain('session:s-3');
  });

  it('caps each group', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `x-${i}`,
      group: 'Projects' as const,
      label: `project ${i}`,
      icon: 'project' as const,
      run: { kind: 'navigate' as const, href: '/' },
    }));
    expect(searchCommands(many, '')[0]?.results).toHaveLength(GROUP_LIMIT.browse);
    expect(searchCommands(many, 'project')[0]?.results).toHaveLength(GROUP_LIMIT.search);
  });

  it('returns nothing when nothing matches', () => {
    expect(searchCommands(commands, 'qqqzzz')).toEqual([]);
  });
});
