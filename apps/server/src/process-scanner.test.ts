import type { PatchOp } from '@yardmaster/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CommandRunner, ProcessScanner } from './process-scanner.js';
import { BoardStore } from './store.js';

const T0 = 1_760_000_000_000;

const PS = [
  '  501     1   1.0 100000 /Applications/Cursor.app/Contents/MacOS/Cursor',
  ' 4242   501   0.0   2048 -zsh',
  ' 4300  4242   2.5  10240 node /home/dev/acme-shop/node_modules/.bin/vite',
].join('\n');
const LSOF = ['p4300', 'cnode', 'f23', 'n127.0.0.1:5173', 'p77', 'cControlCe', 'n*:7000'].join(
  '\n',
);
const SS =
  'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=4300,fd=20))\n' +
  'LISTEN 0 511 *:7000 *:* users:(("other",pid=77,fd=3))';

function enoent(): Error {
  return Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });
}

function setup(outputs: Partial<Record<string, string | Error>>, platform: NodeJS.Platform) {
  const store = new BoardStore({ autoFlush: false, now: () => T0 });
  store.upsertProject({
    id: 'p-shop',
    path: '/home/dev/acme-shop',
    name: 'acme-shop',
    accent: 1,
    source: 'editor',
    git: null,
    createdAt: T0,
    lastActivityAt: null,
  });
  store.upsertTerminal({
    id: 't-1',
    windowId: 'w-1',
    name: 'zsh',
    shellPid: 4242,
    projectId: 'p-shop',
  });
  store.flush();
  const calls: string[] = [];
  const run: CommandRunner = async (file, args) => {
    calls.push([file, ...args].join(' '));
    const out = outputs[file];
    if (out instanceof Error) throw out;
    if (out === undefined) throw enoent();
    return out;
  };
  const logger = { warn: vi.fn(), debug: vi.fn() };
  let now = T0;
  const scanner = new ProcessScanner({ store, logger, platform, run, now: () => now });
  return { store, scanner, calls, logger, tick: (ms: number) => (now += ms) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ProcessScanner', () => {
  it('fills terminal stats and ports on macOS', async () => {
    const { store, scanner, calls } = setup({ ps: PS, lsof: LSOF }, 'darwin');
    await scanner.scanProcesses();
    await scanner.scanPorts();
    expect(calls).toEqual([
      'ps -axo pid=,ppid=,pcpu=,rss=,command=',
      'lsof -nP -iTCP -sTCP:LISTEN -F pcn',
    ]);
    expect(store.state.terminals['t-1']?.stats).toMatchObject({
      pid: 4242,
      cpu: 2.5,
      processCount: 2,
    });
    expect(Object.values(store.state.ports)).toEqual([
      expect.objectContaining({ id: '127.0.0.1:5173', terminalId: 't-1', projectId: 'p-shop' }),
    ]);
    expect(scanner.tree?.procs.size).toBe(3);
  });

  it('drops listeners whose process is not in the latest ps sample', async () => {
    const { store, scanner } = setup({ ps: PS, lsof: LSOF }, 'darwin');
    await scanner.scanProcesses();
    await scanner.scanPorts();
    expect(store.state.ports['*:7000']).toBeUndefined();
  });

  it('emits no ops when nothing changed', async () => {
    const { store, scanner, tick } = setup({ ps: PS, lsof: LSOF }, 'darwin');
    await scanner.scanProcesses();
    await scanner.scanPorts();
    store.flush();
    const ops: PatchOp[] = [];
    store.onPatch((batch) => ops.push(...batch));
    tick(2_000);
    await scanner.scanProcesses();
    await scanner.scanPorts();
    expect(store.flush()).toEqual([]);
    expect(ops).toEqual([]);
  });

  it('clears stats and ports when the shell exits', async () => {
    const outputs: Record<string, string> = { ps: PS, lsof: LSOF };
    const { store, scanner } = setup(outputs, 'darwin');
    await scanner.scanProcesses();
    await scanner.scanPorts();
    outputs.ps = PS.split('\n')[0] ?? '';
    await scanner.scanProcesses();
    expect(store.state.terminals['t-1']?.stats).toBeNull();
    expect(store.state.ports).toEqual({});
  });

  it('attaches ports to a terminal that appears after the port scan', async () => {
    const { store, scanner } = setup({ ps: PS, lsof: LSOF }, 'darwin');
    store.upsertTerminal({ id: 't-1', windowId: 'w-1', name: 'zsh', shellPid: 1 });
    await scanner.scanProcesses();
    await scanner.scanPorts();
    expect(store.state.ports['127.0.0.1:5173']?.terminalId).toBeNull();
    store.upsertTerminal({ id: 't-1', windowId: 'w-1', name: 'zsh', shellPid: 4242 });
    await scanner.scanProcesses();
    expect(store.state.ports['127.0.0.1:5173']?.terminalId).toBe('t-1');
  });

  it('uses ps -eo and falls back to ss when lsof is missing on Linux', async () => {
    const { store, scanner, calls } = setup({ ps: PS, ss: SS }, 'linux');
    await scanner.scanProcesses();
    await scanner.scanPorts();
    await scanner.scanPorts();
    expect(calls).toEqual([
      'ps -eo pid=,ppid=,pcpu=,rss=,args=',
      'lsof -nP -iTCP -sTCP:LISTEN -F pcn',
      'ss -ltnp',
      'ss -ltnp',
    ]);
    expect(store.state.ports['127.0.0.1:5173']?.terminalId).toBe('t-1');
  });

  it('stops scanning ports when lsof is missing on macOS', async () => {
    const { scanner, calls } = setup({ ps: PS }, 'darwin');
    await scanner.scanPorts();
    await scanner.scanPorts();
    expect(calls).toEqual(['lsof -nP -iTCP -sTCP:LISTEN -F pcn']);
  });

  it('logs a failing command once, keeps the last state and never throws', async () => {
    const outputs: Record<string, string | Error> = { ps: PS, lsof: LSOF };
    const { store, scanner, logger } = setup(outputs, 'darwin');
    await scanner.scanProcesses();
    await scanner.scanPorts();
    outputs.ps = new Error('timed out');
    outputs.lsof = new Error('timed out');
    await expect(scanner.scanProcesses()).resolves.toBeUndefined();
    await scanner.scanProcesses();
    await scanner.scanPorts();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(store.state.terminals['t-1']?.stats).not.toBeNull();
    expect(store.state.ports['127.0.0.1:5173']).toBeDefined();
  });

  it('does nothing on unsupported platforms', async () => {
    const { scanner, calls } = setup({ ps: PS, lsof: LSOF }, 'win32');
    scanner.start();
    await scanner.scanProcesses();
    await scanner.scanPorts();
    expect(calls).toEqual([]);
  });

  it('polls ps every 2 s and ports every 5 s, and drops results after stop', async () => {
    vi.useFakeTimers();
    const { scanner, calls } = setup({ ps: PS, lsof: LSOF }, 'darwin');
    scanner.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const count = (tool: string) => calls.filter((call) => call.startsWith(tool)).length;
    expect(count('ps')).toBe(6);
    expect(count('lsof')).toBe(3);
    scanner.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count('ps')).toBe(6);
  });
});
