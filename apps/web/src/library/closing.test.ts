import { type EditorWindow, emptyBoardState, type Project } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { makeProject, makeSession, makeTerminal } from '../test/board.js';
import { closePlan, waitForClosed } from './closing.js';

function editorWindow(id: string, projectIds: string[]): EditorWindow {
  return {
    id,
    appName: 'Cursor',
    appVersion: '2.1.4',
    extensionVersion: '0.1.0',
    workspaceFolders: [],
    projectIds,
    capabilities: { shellExecution: true },
    connectedAt: 1,
    lastSeenAt: 1,
  };
}

describe('closePlan', () => {
  it('sorts what runs in the project into stopped, interrupted and kept', () => {
    const b = emptyBoardState();
    b.terminals.board = { ...makeTerminal('board', 'p1'), origin: 'board', name: 'dev server' };
    b.terminals.ended = { ...makeTerminal('ended', 'p1', 0), origin: 'board' };
    b.terminals.cursor = { ...makeTerminal('cursor', 'p1'), name: 'zsh' };
    b.terminals.claude = { ...makeTerminal('claude', 'p1'), name: 'claude' };
    b.terminals.other = makeTerminal('other', 'p2');
    b.sessions.mine = { ...makeSession('mine', 'p1', { kind: 'working' }), origin: 'board' };
    b.sessions.paused = {
      ...makeSession('paused', 'p1', { kind: 'interrupted', turnRunning: false }),
      origin: 'board',
    };
    b.sessions.term = {
      ...makeSession('term', 'p1', { kind: 'idle' }),
      customTitle: 'Checkout fix',
      terminalId: 'claude',
    };
    b.sessions.done = makeSession('done', 'p1', { kind: 'ended' });
    b.windows.w1 = editorWindow('w1', ['p1']);
    b.windows.w2 = editorWindow('w2', ['p2']);

    const plan = closePlan(b, 'p1');
    expect(plan.stop).toEqual([{ id: 'board', name: 'dev server' }]);
    expect(plan.interrupt.map((i) => i.id)).toEqual(['mine']);
    expect(plan.keep).toEqual([
      { id: 'term', name: 'Checkout fix' },
      { id: 'cursor', name: 'zsh' },
    ]);
    expect(plan.windows).toEqual([{ id: 'w1', appName: 'Cursor' }]);
  });

  it('is empty for a quiet project', () => {
    expect(closePlan(emptyBoardState(), 'p1')).toEqual({
      stop: [],
      interrupt: [],
      keep: [],
      windows: [],
    });
  });
});

describe('waitForClosed', () => {
  it('settles when the patch marking it closed arrives', async () => {
    let projects: Record<string, Project> = { p1: makeProject('p1', 'acme-shop') };
    const listeners = new Set<() => void>();
    const board = {
      get: () => ({ projects }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    let settled = false;
    const waiting = waitForClosed(board, 'p1').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    projects = { p1: { ...makeProject('p1', 'acme-shop'), closedAt: 5 } };
    for (const listener of listeners) listener();
    await waiting;
    expect(listeners.size).toBe(0);
  });

  it('settles at once for a project already gone', async () => {
    await waitForClosed({ get: () => ({ projects: {} }), subscribe: () => () => {} }, 'p1');
  });
});
