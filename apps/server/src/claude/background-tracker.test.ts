import { type ActivityEvent, startBackground } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { buildTree, type ProcessInfo } from '../processes.js';
import { BoardStore } from '../store.js';
import { BackgroundTracker, findProcess } from './background-tracker.js';

const T0 = 1_760_000_000_000;

function proc(pid: number, ppid: number, command: string): ProcessInfo {
  return { pid, ppid, cpu: 0, rssBytes: 0, command };
}

function setup() {
  const store = new BoardStore({ autoFlush: false, now: () => T0 });
  const events: ActivityEvent[] = [];
  const tracker = new BackgroundTracker({
    store,
    onActivity: (e) => events.push(e),
    now: () => T0 + 500,
  });
  store.upsertSession({
    id: 's1',
    projectId: 'p1',
    claudePid: 100,
    status: { kind: 'working' },
    background: startBackground([], {
      id: 'b1',
      kind: 'shell',
      label: 'Watch the build',
      command: 'pnpm --filter web build --watch',
      ts: T0,
    }),
  });
  store.flush();
  return { store, events, tracker };
}

describe('BackgroundTracker', () => {
  it('reports a task start without its label or command', () => {
    const { events } = setup();
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'background.start',
        ts: T0,
        projectId: 'p1',
        sessionId: 's1',
        summary: 'Background shell started',
        data: { taskId: 'b1', taskKind: 'shell', status: 'running', exitCode: null },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('pnpm');
    expect(JSON.stringify(events)).not.toContain('Watch the build');
  });

  it('stops running tasks when the session ends, and reports it', () => {
    const { store, events } = setup();
    store.setSessionStatus('s1', { kind: 'ended' }, T0 + 200);
    store.flush();
    store.flush();
    expect(store.state.sessions.s1?.background?.[0]).toMatchObject({
      status: 'stopped',
      endedAt: T0 + 200,
    });
    expect(events.at(-1)).toMatchObject({
      kind: 'background.end',
      summary: 'Background shell stopped',
    });
  });

  it('stops running tasks of a session interrupted by a restart', () => {
    const { store } = setup();
    store.setSessionStatus('s1', { kind: 'interrupted', turnRunning: false });
    store.flush();
    expect(store.state.sessions.s1?.background?.[0]?.status).toBe('stopped');
  });

  it('finds the shell under Claude, then ends the task when it exits', () => {
    const { store, tracker, events } = setup();
    const running = buildTree(
      new Map([
        [100, proc(100, 1, 'claude')],
        [200, proc(200, 100, "/bin/zsh -c -l eval 'pnpm --filter web build --watch'")],
        [201, proc(201, 200, 'node pnpm --filter web build --watch')],
      ]),
    );
    tracker.sample(running);
    store.flush();
    expect(store.state.sessions.s1?.background?.[0]).toMatchObject({ pid: 200, status: 'running' });

    tracker.sample(running);
    expect(store.flush()).toEqual([]);

    tracker.sample(buildTree(new Map([[100, proc(100, 1, 'claude')]])));
    store.flush();
    expect(store.state.sessions.s1?.background?.[0]).toMatchObject({
      status: 'done',
      endedAt: T0 + 500,
    });
    expect(events.at(-1)).toMatchObject({
      kind: 'background.end',
      summary: 'Background shell finished',
    });
  });

  it('leaves tasks alone while the Claude process is missing from the sample', () => {
    const { store, tracker } = setup();
    tracker.sample(buildTree(new Map([[7, proc(7, 1, 'other')]])));
    expect(store.flush()).toEqual([]);
  });

  it('reports a launch that never ran as one end event', () => {
    const { store, events } = setup();
    store.updateSession('s1', {
      background: startBackground(store.state.sessions.s1?.background ?? [], {
        id: 'b2',
        kind: 'monitor',
        label: 'x',
        ts: T0 + 9,
        status: 'error',
      }),
    });
    store.flush();
    expect(events.at(-1)).toMatchObject({ kind: 'background.end', summary: 'Monitor failed' });
    expect(events.filter((e) => e.data.taskId === 'b2')).toHaveLength(1);
  });
});

describe('findProcess', () => {
  const tree = buildTree(
    new Map([
      [1, proc(1, 0, 'launchd')],
      [100, proc(100, 1, 'claude')],
      [150, proc(150, 100, 'node mcp-server')],
      [200, proc(200, 150, 'bash -c "tail -f logs/dev.log"')],
      [300, proc(300, 1, 'bash -c "tail -f logs/dev.log"')],
    ]),
  );

  it('matches past quoting, only under the root', () => {
    expect(findProcess(tree, 100, "tail -f 'logs/dev.log'")).toBe(200);
    expect(findProcess(tree, 100, 'tail -f logs/dev.log', new Set([200]))).toBeNull();
    expect(findProcess(tree, 100, 'make')).toBeNull();
    expect(findProcess(tree, 100, null)).toBeNull();
  });
});
