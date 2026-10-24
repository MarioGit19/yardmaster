import { type LibraryEntry, projectIdFromPath, type UiAction } from '@yardmaster/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  createLaunchMemory,
  DEFAULT_CHOICE,
  LAUNCH_KEY,
  type LaunchBoard,
  launchBlocker,
  launchSteps,
  launchSummary,
  MAX_REMEMBERED,
  pickerRows,
  runLaunch,
  withoutForgotten,
} from './launch.js';

const entry = (name: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
  name,
  path: `/home/dev/${name}`,
  root: '~/Desktop',
  git: true,
  projectId: null,
  lastActiveAt: null,
  ...extra,
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('pickerRows', () => {
  const entries = [
    entry('acme-shop', { projectId: 'p-acme', lastActiveAt: 2 }),
    entry('garden-planner'),
    entry('tax-notes', { git: false }),
  ];
  const projects = { 'p-acme': { git: { branch: 'feat/cart' } as never } };

  it('keeps the server order (recents first) without a query, with branches for known repos', () => {
    const rows = pickerRows(entries, '  ', projects);
    expect(rows.map((r) => r.entry.name)).toEqual(['acme-shop', 'garden-planner', 'tax-notes']);
    expect(rows.map((r) => r.branch)).toEqual(['feat/cart', null, null]);
  });

  it('fuzzy matches names and highlights them', () => {
    const rows = pickerRows(entries, 'gpl', projects);
    expect(rows.map((r) => r.entry.name)).toEqual(['garden-planner']);
    expect(rows[0]?.indices.length).toBe(3);
  });

  it('ranks a path-only match below name matches, without highlights', () => {
    const rows = pickerRows([entry('notes'), entry('dev-tools')], 'dev', {});
    expect(rows.map((r) => r.entry.name)).toEqual(['dev-tools', 'notes']);
    expect(rows[1]?.indices).toEqual([]);
  });
});

describe('launch plan', () => {
  it('sends the editor first, then Claude, then the terminal', () => {
    const steps = launchSteps(
      'p1',
      {
        editor: true,
        claude: true,
        terminal: true,
        model: 'sonnet',
        permissionMode: 'acceptEdits',
        command: '  pnpm   dev ',
      },
      ' Fix the build ',
    );
    expect(steps.map((s) => s.action)).toEqual([
      { kind: 'project.openInEditor', projectId: 'p1' },
      {
        kind: 'session.create',
        projectId: 'p1',
        prompt: 'Fix the build',
        model: 'sonnet',
        permissionMode: 'acceptEdits',
      },
      { kind: 'terminal.create', projectId: 'p1', command: 'pnpm dev' },
    ]);
  });

  it('leaves the defaults out and a blank command off', () => {
    const steps = launchSteps(
      'p1',
      { ...DEFAULT_CHOICE, editor: false, claude: true, terminal: true },
      'Hi',
    );
    expect(steps.map((s) => s.action)).toEqual([
      { kind: 'session.create', projectId: 'p1', prompt: 'Hi' },
      { kind: 'terminal.create', projectId: 'p1' },
    ]);
  });

  it('blocks a launch with nothing ticked or Claude without a prompt', () => {
    const none = { ...DEFAULT_CHOICE, editor: false };
    expect(launchBlocker(none, '')).toBe('Pick something to start');
    expect(launchBlocker({ ...none, claude: true }, ' ')).toBe('Tell Claude what to do');
    expect(launchBlocker({ ...none, claude: true }, 'Go')).toBeNull();
    expect(launchBlocker(DEFAULT_CHOICE, '')).toBeNull();
    // Board terminals are off and no editor window has the folder.
    expect(launchBlocker({ ...none, terminal: true }, '', true)).toBe(
      'A terminal needs an editor window here',
    );
    expect(launchBlocker({ ...none, terminal: true }, '', false)).toBeNull();
  });

  it('summarizes the choice', () => {
    const all = { ...DEFAULT_CHOICE, claude: true, terminal: true, command: 'pnpm dev' };
    expect(launchSummary(all, 'Cursor')).toBe('Cursor + pnpm dev + Claude');
    expect(launchSummary({ ...all, editor: false, command: '' }, 'Cursor')).toBe(
      'terminal + Claude',
    );
  });
});

describe('launch memory', () => {
  it('remembers the last choice per folder', () => {
    const storage = memoryStorage();
    const memory = createLaunchMemory(storage);
    expect(memory.get('/home/dev/a')).toEqual(DEFAULT_CHOICE);
    const choice = { ...DEFAULT_CHOICE, claude: true, model: 'opus', command: 'pnpm dev' };
    memory.set('/home/dev/a', choice);
    expect(createLaunchMemory(storage).get('/home/dev/a')).toEqual(choice);
    expect(memory.get('/home/dev/b')).toEqual(DEFAULT_CHOICE);
  });

  it('reads broken or hand-edited storage as the default', () => {
    const storage = memoryStorage();
    storage.setItem(LAUNCH_KEY, '{nope');
    expect(createLaunchMemory(storage).get('/a')).toEqual(DEFAULT_CHOICE);
    storage.setItem(
      LAUNCH_KEY,
      JSON.stringify([['/a', { ...DEFAULT_CHOICE, permissionMode: 'yolo' }]]),
    );
    expect(createLaunchMemory(storage).get('/a')).toEqual(DEFAULT_CHOICE);
  });

  it(`keeps the last ${MAX_REMEMBERED} folders`, () => {
    const storage = memoryStorage();
    const memory = createLaunchMemory(storage);
    for (let i = 0; i <= MAX_REMEMBERED; i++)
      memory.set(`/f${i}`, { ...DEFAULT_CHOICE, claude: true });
    expect(memory.get('/f0')).toEqual(DEFAULT_CHOICE);
    expect(memory.get(`/f${MAX_REMEMBERED}`).claude).toBe(true);
    expect(JSON.parse(storage.data.get(LAUNCH_KEY) ?? '[]')).toHaveLength(MAX_REMEMBERED);
  });
});

describe('runLaunch', () => {
  function fakeBoard(initial: string[] = []) {
    const ids = new Set(initial);
    const listeners = new Set<() => void>();
    const board: LaunchBoard = {
      has: (id) => ids.has(id),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const add = (id: string) => {
      ids.add(id);
      for (const l of listeners) l();
    };
    return { board, add, listeners };
  }

  it('adds a folder, waits for it, then starts every step in order', async () => {
    const { board, add, listeners } = fakeBoard();
    const id = projectIdFromPath('/home/dev/garden-planner');
    const sent: UiAction[] = [];
    const client = {
      action: vi.fn(async (action: UiAction) => {
        sent.push(action);
        if (action.kind === 'project.add') setTimeout(() => add(id), 0);
        if (action.kind === 'session.create') return { ok: true as const, sessionId: 's1' };
        if (action.kind === 'project.openInEditor')
          return { ok: false as const, error: 'not_implemented' };
        return { ok: true as const };
      }),
    };
    const outcome = await runLaunch({
      client,
      board,
      entry: entry('garden-planner'),
      choice: { ...DEFAULT_CHOICE, claude: true, terminal: true, command: 'pnpm dev' },
      prompt: 'Plan the beds',
    });
    expect(outcome).toEqual({
      ok: true,
      projectId: id,
      sessionId: 's1',
      failed: [{ kind: 'editor', error: 'not_implemented' }],
    });
    expect(sent.map((a) => a.kind)).toEqual([
      'project.add',
      'project.openInEditor',
      'session.create',
      'terminal.create',
    ]);
    expect(listeners.size).toBe(0);
  });

  it('skips the add for a project already on the board', async () => {
    const { board } = fakeBoard(['p-acme']);
    const client = { action: vi.fn(async (_action: UiAction) => ({ ok: true as const })) };
    await runLaunch({
      client,
      board,
      entry: entry('acme-shop', { projectId: 'p-acme' }),
      choice: DEFAULT_CHOICE,
      prompt: '',
    });
    expect(client.action.mock.calls.map(([a]) => a)).toEqual([
      { kind: 'project.openInEditor', projectId: 'p-acme' },
    ]);
  });

  it('stops when the add is refused or the project never shows up', async () => {
    const refused = {
      action: vi.fn(async () => ({ ok: false as const, error: 'outside_library' })),
    };
    expect(
      await runLaunch({
        client: refused,
        board: fakeBoard().board,
        entry: entry('x'),
        choice: DEFAULT_CHOICE,
        prompt: '',
      }),
    ).toEqual({ ok: false, error: 'outside_library' });

    const silent = { action: vi.fn(async () => ({ ok: true as const })) };
    expect(
      await runLaunch({
        client: silent,
        board: fakeBoard().board,
        entry: entry('x'),
        choice: DEFAULT_CHOICE,
        prompt: '',
        timeoutMs: 10,
      }),
    ).toEqual({ ok: false, error: 'timeout' });
    expect(silent.action).toHaveBeenCalledTimes(1);
  });
});

describe('withoutForgotten', () => {
  const entry = (name: string, projectId: string | null, lastActiveAt: number | null) => ({
    name,
    path: `/home/dev/${name}`,
    root: '~/Desktop',
    git: false,
    projectId,
    lastActiveAt,
  });

  it('drops a forgotten project from the recents and sorts it by name', () => {
    const entries = [
      entry('zen', 'p-zen', 30),
      entry('acme', 'p-acme', 20),
      entry('blog', null, null),
    ];
    const same = withoutForgotten(entries, { 'p-zen': {}, 'p-acme': {} });
    expect(same).toBe(entries);
    expect(
      withoutForgotten(entries, { 'p-acme': {} }).map((e) => [e.name, e.lastActiveAt]),
    ).toEqual([
      ['acme', 20],
      ['blog', null],
      ['zen', null],
    ]);
  });
});
