import { type BoardState, type EditorWindow, emptyBoardState } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { makeProject, makeSession, makeTerminal } from '../test/board.js';
import { type ActiveRule, activeKey, activeProjectIds, closedProjectIds } from './active.js';

const NOW = 10_000_000;
const MIN = 60_000;

function rule(over: Partial<ActiveRule> = {}): ActiveRule {
  return { now: NOW, idleHideMs: 30 * MIN, pinned: new Set(), opened: new Map(), ...over };
}

function editorWindow(id: string, projectIds: string[]): EditorWindow {
  return {
    id,
    appName: 'Cursor',
    appVersion: '2.1.4',
    extensionVersion: '0.1.0',
    workspaceFolders: [],
    projectIds,
    capabilities: { shellExecution: true },
    connectedAt: NOW - 60 * MIN,
    lastSeenAt: NOW,
  };
}

/** Projects a–h, all quiet for two hours unless a test says otherwise. */
function board(): BoardState {
  const b = emptyBoardState();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    b.projects[id] = { ...makeProject(id, `project-${id}`), lastActivityAt: NOW - 120 * MIN };
  }
  return b;
}

describe('activeProjectIds', () => {
  it('keeps projects with an editor window, an open terminal or a live session', () => {
    const b = board();
    b.windows.w1 = editorWindow('w1', ['a']);
    b.terminals.t1 = makeTerminal('t1', 'b');
    b.terminals.t2 = makeTerminal('t2', 'c', 1); // closed
    b.sessions.s1 = makeSession('s1', 'd', { kind: 'working' });
    b.sessions.s2 = makeSession('s2', 'e', { kind: 'ended' });
    b.sessions.s3 = makeSession('s3', 'f', { kind: 'interrupted', turnRunning: false });
    b.sessions.s4 = makeSession('s4', 'g', { kind: 'waiting_permission', approvalId: null });

    expect([...activeProjectIds(b, rule())].sort()).toEqual(['a', 'b', 'd', 'g']);
  });

  it('keeps a project active within the idle window, and drops it after', () => {
    const b = board();
    const a = b.projects.a;
    const c = b.projects.c;
    if (!a || !c) throw new Error('missing project');
    b.projects.a = { ...a, lastActivityAt: NOW - 29 * MIN };
    b.projects.b = { ...makeProject('b', 'project-b'), lastActivityAt: NOW - 30 * MIN };
    b.projects.c = { ...c, lastActivityAt: NOW - 31 * MIN };
    b.projects.d = { ...makeProject('d', 'project-d'), lastActivityAt: null };

    expect([...activeProjectIds(b, rule())].sort()).toEqual(['a', 'b']);
    expect([...activeProjectIds(b, rule({ idleHideMs: 15 * MIN }))]).toEqual([]);
    expect([...activeProjectIds(b, rule({ now: NOW + 2 * MIN }))]).toEqual([]);
  });

  it('keeps pinned projects and ones the user just opened from the board', () => {
    const b = board();
    const active = activeProjectIds(
      b,
      rule({
        pinned: new Set(['a', 'gone']),
        opened: new Map([
          ['b', NOW - 5 * MIN],
          ['c', NOW - 45 * MIN],
        ]),
      }),
    );
    expect([...active].sort()).toEqual(['a', 'b']);
  });

  it('ignores windows and terminals that name a project the board dropped', () => {
    const b = board();
    b.windows.w1 = editorWindow('w1', ['missing']);
    b.terminals.t1 = makeTerminal('t1', 'missing');
    expect(activeProjectIds(b, rule()).size).toBe(0);
  });

  it('activeKey is stable and sorted', () => {
    const b = board();
    b.windows.w1 = editorWindow('w1', ['h', 'a']);
    expect(activeKey(b, rule())).toBe('a\nh');
    expect(activeKey(emptyBoardState(), rule())).toBe('');
  });
});

describe('closed projects', () => {
  const closed = (b: BoardState, id: string, at: number) => {
    const project = b.projects[id];
    if (project) b.projects[id] = { ...project, closedAt: at };
  };

  it('hides a closed project whatever is still running there from before', () => {
    const b = board();
    b.windows.w1 = editorWindow('w1', ['a']);
    b.terminals.t1 = { ...makeTerminal('t1', 'a'), createdAt: NOW - 60 * MIN };
    b.sessions.s1 = { ...makeSession('s1', 'a', { kind: 'working' }), startedAt: NOW - 60 * MIN };
    b.projects.b = { ...makeProject('b', 'project-b'), lastActivityAt: NOW };
    closed(b, 'a', NOW - 10 * MIN);
    closed(b, 'b', NOW - 10 * MIN);
    const active = activeProjectIds(b, rule({ pinned: new Set(['a']) }));
    expect(active.has('a')).toBe(false);
    expect(active.has('b')).toBe(false);
    expect([...closedProjectIds(b)].sort()).toEqual(['a', 'b']);
  });

  it('brings it back for a new terminal, session, window, or opening it', () => {
    const b = board();
    for (const id of ['a', 'b', 'c', 'd', 'e']) closed(b, id, NOW - 10 * MIN);
    b.terminals.t1 = { ...makeTerminal('t1', 'a'), createdAt: NOW - MIN };
    b.terminals.t2 = { ...makeTerminal('t2', 'e', 0), createdAt: NOW - MIN }; // already exited
    b.sessions.s1 = { ...makeSession('s1', 'b', { kind: 'working' }), startedAt: NOW - MIN };
    b.windows.w1 = { ...editorWindow('w1', ['c']), connectedAt: NOW - MIN };
    const active = activeProjectIds(b, rule({ opened: new Map([['d', NOW - MIN]]) }));
    expect([...active].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...closedProjectIds(b)].sort()).toEqual(['d', 'e']);
  });
});
