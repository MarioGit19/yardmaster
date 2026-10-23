import { BOARD_WINDOW_ID, type Project } from '@c-board/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult } from './actions.js';
import { loadNodePty, type PtyLoad } from './pty.js';
import { PTY_ERRORS, PtyManager, type PtyManagerOptions, shellEnv } from './pty-manager.js';
import { BoardStore } from './store.js';

const loaded = await loadNodePty();
const realPty = describe.skipIf(!loaded.ok);

const PROJECT: Project = {
  id: 'p-acme',
  path: '/tmp',
  name: 'acme-shop',
  accent: 2,
  source: 'manual',
  git: null,
  createdAt: 1,
  lastActivityAt: null,
};

const managers: PtyManager[] = [];

function setup(options: Partial<PtyManagerOptions> = {}) {
  const store = new BoardStore();
  store.upsertProject(PROJECT);
  let n = 0;
  const manager = new PtyManager({
    store,
    load: async () => loaded,
    // A plain sh with a fixed prompt, so the tests don't depend on the user's shell or rc files.
    shell: { file: '/bin/sh', args: [] },
    env: () => ({ PATH: '/usr/bin:/bin', TERM: 'xterm-256color', PS1: '$ ', LANG: 'C' }),
    newId: () => `board-t${++n}`,
    flushMs: 1,
    ...options,
  });
  managers.push(manager);
  return { store, manager };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stopAll();
});

const output = (store: BoardStore, id: string) =>
  (store.output.read(`term:${id}`)?.chunks ?? []).map((c) => c.chunk).join('');

async function created(manager: PtyManager, command?: string): Promise<string> {
  const result = await manager.create({
    projectId: PROJECT.id,
    cwd: PROJECT.path,
    name: PROJECT.name,
    ...(command !== undefined ? { command } : {}),
  });
  if (!result.ok || !result.terminalId) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.terminalId;
}

realPty('PtyManager with a real pty', () => {
  it('runs a shell in the project folder and streams its output', async () => {
    const { store, manager } = setup();
    const id = await created(manager);
    expect(store.state.terminals[id]).toMatchObject({
      windowId: BOARD_WINDOW_ID,
      origin: 'board',
      projectId: PROJECT.id,
      name: 'acme-shop',
      cwd: '/tmp',
      state: 'open',
      active: true,
    });
    expect(store.state.terminals[id]?.shellPid).toBeGreaterThan(0);
    expect(manager.liveCount).toBe(1);

    manager.input(id, 'echo hello-$((40 + 2)); pwd\r');
    await vi.waitFor(() => expect(output(store, id)).toContain('hello-42'), { timeout: 5_000 });
    await vi.waitFor(() => expect(output(store, id)).toMatch(/\/tmp\r?\n/));
  });

  it('types the initial command', async () => {
    const { store, manager } = setup();
    const id = await created(manager, 'echo started-$((1 + 1))');
    await vi.waitFor(() => expect(output(store, id)).toContain('started-2'), { timeout: 5_000 });
  });

  it('closes the terminal with the exit code', async () => {
    const { store, manager } = setup();
    const id = await created(manager);
    manager.sendText(id, 'exit 7', true);
    await vi.waitFor(() => expect(store.state.terminals[id]?.state).toBe('closed'), {
      timeout: 5_000,
    });
    expect(store.state.terminals[id]).toMatchObject({ exitCode: 7, active: false });
    expect(manager.liveCount).toBe(0);
    // Its output stays readable, and input to it is refused.
    expect(output(store, id)).toContain('exit 7');
    expect(manager.input(id, 'x')).toEqual({ ok: false, error: 'terminal_closed' });
  });

  it('interrupts a running command with Ctrl+C', async () => {
    const { store, manager } = setup();
    const id = await created(manager);
    // The child shell says when it runs (the echoed line reads `st''arted`, its output
    // `started`), so the interrupt can't reach the parent shell before it forked.
    manager.sendText(id, "sh -c 'echo st''arted; sleep 30'; echo after-$?", true);
    await vi.waitFor(() => expect(output(store, id)).toContain('started'), { timeout: 5_000 });
    expect(manager.interrupt(id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(output(store, id)).toContain('after-130'), { timeout: 5_000 });
  });

  it('resizes the pty', async () => {
    const { store, manager } = setup();
    const id = await created(manager);
    expect(manager.resize(id, 101, 37)).toEqual({ ok: true });
    manager.sendText(id, 'stty size', true);
    await vi.waitFor(() => expect(output(store, id)).toContain('37 101'), { timeout: 5_000 });
  });

  it('kills a terminal on close, then removes it on a second close', async () => {
    const { store, manager } = setup();
    const id = await created(manager);
    expect(manager.close(id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(store.state.terminals[id]?.state).toBe('closed'), {
      timeout: 5_000,
    });
    expect(manager.close(id)).toEqual({ ok: true });
    expect(store.state.terminals[id]).toBeUndefined();
  });

  it('ends every shell when the server stops, without touching the board again', async () => {
    const { store, manager } = setup();
    const id = await created(manager);
    const pid = store.state.terminals[id]?.shellPid as number;
    manager.stopAll();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });
    expect(store.state.terminals[id]?.state).toBe('open');
    expect(await manager.create({ projectId: PROJECT.id, cwd: '/tmp', name: 'x' })).toEqual({
      ok: false,
      error: PTY_ERRORS.unavailable,
    });
  });

  it('runs at most `max` terminals', async () => {
    const { manager } = setup({ max: 2 });
    await created(manager);
    const second = created(manager);
    const third = manager.create({ projectId: PROJECT.id, cwd: '/tmp', name: 'x' });
    await second;
    expect(await third).toEqual({ ok: false, error: PTY_ERRORS.tooMany });
  });
});

describe('PtyManager without a pty', () => {
  const fake = (): PtyLoad => ({
    ok: true,
    spawn: () => ({
      pid: 4242,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
    }),
  });

  it('refuses when node-pty did not load', async () => {
    const { manager } = setup({ load: async () => ({ ok: false, reason: 'no binary' }) });
    expect(await manager.availability()).toEqual({ available: false, reason: 'no binary' });
    const create = manager.createAction();
    expect(await create({ kind: 'terminal.create', projectId: PROJECT.id })).toEqual({
      ok: false,
      error: PTY_ERRORS.unavailable,
    });
  });

  it('answers a spawn failure', async () => {
    const { manager } = setup({
      load: async () => ({
        ok: true,
        spawn: () => {
          throw new Error('posix_spawnp failed');
        },
      }),
    });
    expect(await manager.create({ projectId: PROJECT.id, cwd: '/tmp', name: 'x' })).toEqual({
      ok: false,
      error: PTY_ERRORS.spawnFailed,
    });
  });

  it('creates in the project folder, named after it, and only the newest is active', async () => {
    const { store, manager } = setup({ load: async () => fake() });
    const create = manager.createAction();
    expect(await create({ kind: 'terminal.create', projectId: PROJECT.id })).toEqual({ ok: true });
    expect(
      await create({ kind: 'terminal.create', projectId: PROJECT.id, name: 'server' }),
    ).toEqual({ ok: true });
    expect(store.state.terminals['board-t1']).toMatchObject({ name: 'acme-shop', active: false });
    expect(store.state.terminals['board-t2']).toMatchObject({
      name: 'server',
      cwd: '/tmp',
      active: true,
    });
    expect(await create({ kind: 'terminal.create', projectId: 'nope' })).toEqual({
      ok: false,
      error: 'unknown_project',
    });
  });

  it('routes actions on board terminals here and the rest to the editor', async () => {
    const { store, manager } = setup({ load: async () => fake() });
    const id = await created(manager);
    store.upsertTerminal({ id: 'ed-1', windowId: 'w1', name: 'zsh' });
    const editor = vi.fn((): ActionResult => ({ ok: true }));
    const actions = manager.actions({
      'terminal.sendText': editor,
      'terminal.interrupt': editor,
      'terminal.rerun': editor,
      'terminal.focus': editor,
      'terminal.close': editor,
    });
    await actions['terminal.sendText']({
      kind: 'terminal.sendText',
      terminalId: id,
      text: 'ls',
      execute: true,
    });
    await actions['terminal.focus']({ kind: 'terminal.focus', terminalId: id });
    expect(editor).not.toHaveBeenCalled();
    await actions['terminal.sendText']({
      kind: 'terminal.sendText',
      terminalId: 'ed-1',
      text: 'ls',
      execute: true,
    });
    await actions['terminal.close']({ kind: 'terminal.close', terminalId: 'ed-1' });
    expect(editor).toHaveBeenCalledTimes(2);
  });
});

describe('shellEnv', () => {
  it('drops what marks an editor terminal and sets a color terminal', () => {
    const env = shellEnv({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      TERM: 'dumb',
      TERM_PROGRAM: 'vscode',
      VSCODE_INJECTION: '1',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });
  });
});
