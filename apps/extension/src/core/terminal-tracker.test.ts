import type { EditorTerminal } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { type TerminalLike, type TerminalSink, TerminalTracker } from './terminal-tracker.js';

interface FakeTerminal extends TerminalLike {
  name: string;
  exitStatus: { code: number | undefined } | undefined;
  shellIntegration: { cwd: { scheme: string; fsPath: string } | undefined } | undefined;
  resolvePid(pid: number | undefined): void;
}

function fakeTerminal(
  name: string,
  creationOptions: TerminalLike['creationOptions'] = {},
): FakeTerminal {
  let resolvePid: (pid: number | undefined) => void = () => {};
  const processId = new Promise<number | undefined>((resolve) => {
    resolvePid = resolve;
  });
  return {
    name,
    processId,
    creationOptions,
    exitStatus: undefined,
    shellIntegration: undefined,
    resolvePid: (pid) => resolvePid(pid),
  };
}

const fileUri = (fsPath: string) => ({ scheme: 'file', fsPath });

type Sent =
  | { type: 'upsert'; terminal: EditorTerminal }
  | { type: 'closed'; terminalId: string; exitCode: number | null }
  | { type: 'sync'; terminals: EditorTerminal[] };

function setup() {
  const sent: Sent[] = [];
  const sink: TerminalSink = {
    upsert: (terminal) => sent.push({ type: 'upsert', terminal }),
    closed: (terminalId, exitCode) => sent.push({ type: 'closed', terminalId, exitCode }),
    sync: (terminals) => sent.push({ type: 'sync', terminals }),
  };
  let active: FakeTerminal | undefined;
  let counter = 0;
  const tracker = new TerminalTracker<FakeTerminal>({
    sink,
    activeTerminal: () => active,
    newId: () => `term-${++counter}`,
  });
  const take = () => sent.splice(0);
  const setActive = (terminal: FakeTerminal | undefined) => {
    active = terminal;
  };
  return { tracker, take, setActive };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TerminalTracker', () => {
  it('upserts an opened terminal, then again once its pid is known', async () => {
    const { tracker, take, setActive } = setup();
    const zsh = fakeTerminal('zsh', { cwd: '/home/dev/acme-shop' });
    setActive(zsh);
    tracker.opened(zsh);
    expect(take()).toEqual([
      {
        type: 'upsert',
        terminal: {
          terminalId: 'term-1',
          name: 'zsh',
          shellPid: null,
          cwd: '/home/dev/acme-shop',
          state: 'open',
          shellIntegration: false,
          active: true,
          exitCode: null,
        },
      },
    ]);

    zsh.resolvePid(4242);
    await flush();
    expect(take()).toMatchObject([{ type: 'upsert', terminal: { shellPid: 4242 } }]);
  });

  it('keeps a stable id per terminal object', () => {
    const { tracker } = setup();
    const a = fakeTerminal('a');
    const b = fakeTerminal('b');
    expect(tracker.idOf(a)).toBe('term-1');
    expect(tracker.idOf(b)).toBe('term-2');
    expect(tracker.idOf(a)).toBe('term-1');
  });

  it('prefers the shell-integration cwd and only reports local absolute paths', () => {
    const { tracker } = setup();
    const t = fakeTerminal('zsh', { cwd: fileUri('/home/dev/acme-shop') });
    expect(tracker.describe(t).cwd).toBe('/home/dev/acme-shop');

    t.shellIntegration = { cwd: fileUri('/home/dev/acme-shop/apps/web') };
    expect(tracker.describe(t)).toMatchObject({
      cwd: '/home/dev/acme-shop/apps/web',
      shellIntegration: true,
    });

    t.shellIntegration = { cwd: { scheme: 'vscode-remote', fsPath: '/srv/app' } };
    expect(tracker.describe(t).cwd).toBe('/home/dev/acme-shop');
    expect(tracker.describe(fakeTerminal('x', { cwd: 'relative/dir' })).cwd).toBeNull();
  });

  it('falls back to the creation name and clips long names', () => {
    const { tracker } = setup();
    expect(tracker.describe(fakeTerminal('', { name: 'dev server' })).name).toBe('dev server');
    expect(tracker.describe(fakeTerminal('')).name).toBe('terminal');
    expect(tracker.describe(fakeTerminal('n'.repeat(400))).name).toHaveLength(256);
  });

  it('ignores a pid the editor does not know', async () => {
    const { tracker, take } = setup();
    const t = fakeTerminal('zsh');
    tracker.opened(t);
    take();
    t.resolvePid(undefined);
    await flush();
    expect(take()).toEqual([]);
    expect(tracker.describe(t).shellPid).toBeNull();
  });

  it('upserts on changes and picks up terminals it has not seen', () => {
    const { tracker, take } = setup();
    const t = fakeTerminal('zsh');
    tracker.changed(t);
    t.shellIntegration = { cwd: fileUri('/home/dev/acme-api') };
    tracker.changed(t);
    expect(take().map((m) => m.type === 'upsert' && m.terminal.cwd)).toEqual([
      null,
      '/home/dev/acme-api',
    ]);
  });

  it('upserts only the terminals renamed since their last report', async () => {
    const { tracker, take } = setup();
    const backend = fakeTerminal('zsh');
    const web = fakeTerminal('zsh');
    tracker.opened(backend);
    tracker.opened(web);
    backend.resolvePid(undefined);
    web.resolvePid(undefined);
    await flush();
    take();

    tracker.refreshNames();
    expect(take()).toEqual([]);

    backend.name = 'backend';
    tracker.refreshNames();
    expect(
      take().map((m) => m.type === 'upsert' && [m.terminal.terminalId, m.terminal.name]),
    ).toEqual([['term-1', 'backend']]);
    tracker.refreshNames();
    expect(take()).toEqual([]);

    // A closed terminal is no longer polled.
    web.name = 'storefront';
    web.exitStatus = { code: 0 };
    tracker.closed(web);
    take();
    tracker.refreshNames();
    expect(take()).toEqual([]);
  });

  it('upserts both the previous and the new active terminal', () => {
    const { tracker, take, setActive } = setup();
    const a = fakeTerminal('a');
    const b = fakeTerminal('b');
    setActive(a);
    tracker.opened(a);
    tracker.opened(b);
    tracker.activeChanged();
    take();

    setActive(b);
    tracker.activeChanged();
    expect(
      take().map((m) => m.type === 'upsert' && [m.terminal.terminalId, m.terminal.active]),
    ).toEqual([
      ['term-1', false],
      ['term-2', true],
    ]);

    tracker.activeChanged();
    expect(take()).toEqual([]);
  });

  it('sends the exit code on close, once', () => {
    const { tracker, take } = setup();
    const t = fakeTerminal('zsh');
    tracker.opened(t);
    take();
    t.exitStatus = { code: 130 };
    tracker.closed(t);
    tracker.closed(t);
    tracker.changed(t);
    expect(take()).toEqual([{ type: 'closed', terminalId: 'term-1', exitCode: 130 }]);
    expect(tracker.describe(t)).toMatchObject({ state: 'closed', active: false, exitCode: 130 });
  });

  it('reports an unknown exit code as null', () => {
    const { tracker, take } = setup();
    const t = fakeTerminal('zsh');
    tracker.opened(t);
    take();
    t.exitStatus = { code: undefined };
    tracker.closed(t);
    expect(take()).toEqual([{ type: 'closed', terminalId: 'term-1', exitCode: null }]);
  });

  it('syncs the full list, reconciled with the editor', () => {
    const { tracker, take, setActive } = setup();
    const a = fakeTerminal('a');
    const b = fakeTerminal('b');
    const c = fakeTerminal('c');
    const gone = fakeTerminal('gone');
    tracker.opened(a);
    tracker.opened(gone);
    tracker.opened(b);
    take();

    c.exitStatus = { code: 0 };
    setActive(b);
    tracker.sync([a, b, c]);
    const sent = take();
    expect(sent).toHaveLength(1);
    const [sync] = sent;
    expect(sync?.type === 'sync' && sync.terminals.map((t) => [t.name, t.active])).toEqual([
      ['a', false],
      ['b', true],
    ]);

    // A terminal dropped by the sync is no longer reported as closed later.
    tracker.closed(gone);
    expect(take()).toEqual([]);
  });

  it('keeps ids across syncs, so a reconnect does not duplicate terminals', () => {
    const { tracker, take } = setup();
    const a = fakeTerminal('a');
    tracker.sync([a]);
    tracker.sync([a]);
    const ids = take().map((m) => m.type === 'sync' && m.terminals.map((t) => t.terminalId));
    expect(ids).toEqual([['term-1'], ['term-1']]);
  });

  it('finds open terminals by id', () => {
    const { tracker } = setup();
    const zsh = fakeTerminal('zsh');
    const bash = fakeTerminal('bash');
    tracker.opened(zsh);
    tracker.opened(bash);
    expect(tracker.find('term-1')).toBe(zsh);
    expect(tracker.find('term-2')).toBe(bash);
    expect(tracker.find('term-9')).toBeUndefined();
    tracker.closed(zsh);
    expect(tracker.find('term-1')).toBeUndefined();
  });
});
