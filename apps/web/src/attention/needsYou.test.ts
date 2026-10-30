import type { Approval, BoardState, SeenResponse } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { createBoardStore } from '../data/index.js';
import { makeProject, makeSession, makeTerminal } from '../test/board.js';
import { selectStripItems } from './needsYou.js';

const NOW = 1_000_000;
const SEEN: SeenResponse = { since: 0, marks: {} };

function approval(id: string, sessionId: string, createdAt: number): Approval {
  return {
    id,
    sessionId,
    source: 'sdk',
    tool: 'Bash',
    input: { command: 'pnpm test' },
    toolUseId: null,
    createdAt,
    expiresAt: null,
    state: 'pending',
    decidedAt: null,
    reason: null,
  };
}

function strip(board: Partial<BoardState>, seen: SeenResponse = SEEN) {
  const store = createBoardStore();
  const empty = store.getState().board;
  store.getState().replaceBoard({ ...empty, ...board });
  return selectStripItems(seen, NOW)(store.getState());
}

function failedTerminal(
  code: number,
  over: { state?: 'open' | 'closed'; commandLine?: string } = {},
): Pick<BoardState, 'terminals' | 'executions'> {
  const execution = {
    id: 'x1',
    terminalId: 't1',
    commandLine: over.commandLine ?? 'pnpm build',
    cwd: '/home/dev/acme-shop',
    startedAt: 100,
    endedAt: 500,
    exitCode: code,
    outputBytes: 0,
    interactive: false,
  };
  return {
    terminals: {
      t1: {
        ...makeTerminal('t1', 'p'),
        windowId: 'w',
        executionIds: ['x1'],
        state: over.state ?? 'open',
      },
    },
    executions: { x1: execution as BoardState['executions'][string] },
  };
}

const projects = { p: makeProject('p', 'acme-shop') };

describe('selectStripItems', () => {
  it('is empty when nothing needs you', () => {
    const idle = makeSession('s1', 'p', { kind: 'idle' }, 'Done');
    expect(strip({ projects, sessions: { s1: idle } })).toEqual([]);
  });

  it('lists approvals, questions and failures, oldest first', () => {
    const waiting = makeSession('s1', 'p', { kind: 'waiting_permission', approvalId: 'a1' }, 'One');
    const asking = {
      ...makeSession('s2', 'p', { kind: 'waiting_input' }, 'Two'),
      updatedAt: 200,
    };
    const items = strip({
      projects,
      sessions: { s1: waiting, s2: asking },
      approvals: { a1: approval('a1', 's1', 300) },
      ...failedTerminal(1),
    });
    expect(items.map((item) => item.key)).toEqual(['s:s2', 's:s1', 't:t1']);
    expect(items.map((item) => item.since)).toEqual([200, 300, 500]);
    expect(items.map((item) => item.token)).toEqual(['needs_you', 'needs_you', 'failed']);
  });

  it('offers a pending approval to decide', () => {
    const session = makeSession('s1', 'p', { kind: 'waiting_permission', approvalId: 'a1' }, 'One');
    const [item] = strip({
      projects,
      sessions: { s1: session },
      approvals: { a1: approval('a1', 's1', 300) },
    });
    expect(item).toMatchObject({ approvalId: 'a1', project: 'acme-shop', rerun: null });
    expect(item?.href).toContain('s1');
  });

  it('sends an approval the board cannot answer to its session', () => {
    const session = makeSession('s1', 'p', { kind: 'waiting_permission', approvalId: null }, 'One');
    const [item] = strip({ projects, sessions: { s1: session } });
    expect(item?.approvalId).toBeNull();
    expect(item?.href).toContain('s1');
  });

  it('offers a failed command to run again', () => {
    const [item] = strip({ projects, ...failedTerminal(2) });
    expect(item?.rerun).toEqual({ execId: 'x1', command: 'pnpm build' });
    expect(item?.reason).toBe('pnpm build exited 2');
  });

  it('never offers to re-run what it cannot: a closed terminal or an unsafe command', () => {
    expect(strip({ projects, ...failedTerminal(1, { state: 'closed' }) })[0]?.rerun).toBeNull();
    const unsafe = failedTerminal(1, { commandLine: 'echo ok\u001b[8m' });
    expect(strip({ projects, ...unsafe })[0]?.rerun).toBeNull();
  });

  it('leaves out Ctrl+C and failures this browser has opened', () => {
    expect(strip({ projects, ...failedTerminal(130) })).toEqual([]);
    const seen = { since: 0, marks: { x1: 1 } };
    expect(strip({ projects, ...failedTerminal(1) }, seen)).toEqual([]);
  });

  it('names a session no project has claimed', () => {
    const session = { ...makeSession('s1', '', { kind: 'waiting_input' }, 'One'), projectId: null };
    const [item] = strip({ sessions: { s1: session } });
    expect(item).toMatchObject({ project: 'No project', href: null });
  });
});
