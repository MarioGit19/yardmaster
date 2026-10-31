import type { ClaudeSession, Execution, SeenResponse, Terminal } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { createBoardStore } from '../data/index.js';
import { makeProject, makeSession, makeTerminal } from '../test/board.js';
import { hasNews, isEmptyRecap, selectDotMarks, selectRecap } from './model.js';

const FROM = 1_000_000;
const NOW = FROM + 3_600_000;
const SEEN: SeenResponse = { since: 0, marks: {} };

const session = (
  id: string,
  status: ClaudeSession['status'],
  over: Partial<ClaudeSession> = {},
): ClaudeSession => ({ ...makeSession(id, 'p1', status), updatedAt: NOW, ...over });

const finished = (id: string, at: number, over: Partial<ClaudeSession> = {}) =>
  session(
    id,
    { kind: 'idle' },
    { lastAssistantText: 'Fixed the cart total', lastAssistantAt: at, ...over },
  );

const failedTerminal = () => ({
  terminals: [{ ...makeTerminal('t1', 'p1'), executionIds: ['x1'] }],
  executions: [execution({})],
});

function state(
  sessions: ClaudeSession[],
  extra: { terminals?: Terminal[]; executions?: Execution[] } = {},
) {
  const store = createBoardStore();
  const project = makeProject('p1', 'acme-shop');
  const git = { dirty: 3 } as NonNullable<typeof project.git>;
  store.getState().replaceBoard({
    ...store.getState().board,
    projects: { p1: { ...project, git } },
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    terminals: Object.fromEntries((extra.terminals ?? []).map((t) => [t.id, t])),
    executions: Object.fromEntries((extra.executions ?? []).map((e) => [e.id, e])),
  });
  return store.getState();
}

const execution = (over: Partial<Execution>): Execution => ({
  id: 'x1',
  terminalId: 't1',
  commandLine: 'pnpm build',
  confidence: 'high',
  cwd: null,
  startedAt: FROM + 10,
  endedAt: FROM + 500,
  exitCode: 1,
  outputBytes: 10,
  truncated: false,
  interactive: false,
  ...over,
});

describe('selectRecap', () => {
  it('orders needs you, failed, finished, running, with the facts each one needs', () => {
    const s = state(
      [
        session('wait', { kind: 'waiting_input' }),
        session('bad', { kind: 'error', message: 'Request failed' }, { updatedAt: FROM + 5 }),
        finished('done', FROM + 100),
        session('busy', { kind: 'working' }),
      ],
      failedTerminal(),
    );
    const recap = selectRecap(SEEN, FROM, NOW)(s);
    expect(recap.needs_you.map((i) => i.key)).toEqual(['s:wait']);
    expect(recap.failed.map((i) => i.key).sort()).toEqual(['s:bad', 't:t1']);
    const terminal = recap.failed.find((i) => i.key === 't:t1');
    expect(terminal?.detail).toBe('pnpm build exited 1');
    expect(terminal?.execId).toBe('x1');
    expect(recap.finished[0]).toMatchObject({
      key: 's:done',
      detail: 'Fixed the cart total',
      filesChanged: 3,
    });
    expect(recap.running.map((i) => i.key)).toEqual(['s:busy']);
  });

  it('leaves out what finished before the absence, was opened, or is archived', () => {
    const s = state([
      finished('old', FROM - 1),
      finished('opened', FROM + 100),
      finished('gone', FROM + 100, {
        status: { kind: 'ended' },
        endedAt: FROM + 100,
        archivedAt: FROM + 200,
      }),
    ]);
    const seen = { since: 0, marks: { 's:opened': FROM + 100 } };
    expect(selectRecap(seen, FROM, NOW)(s).finished).toEqual([]);
  });

  it('counts an ended session, and falls back on the compaction summary', () => {
    const s = state([
      finished('ended', FROM + 100, {
        status: { kind: 'ended' },
        endedAt: FROM + 200,
        lastAssistantText: null,
        lastAssistantAt: null,
        compactSummary: 'Migrated the ledger tables',
      }),
    ]);
    const [item] = selectRecap(SEEN, FROM, NOW)(s).finished;
    expect(item?.detail).toBe('Migrated the ledger tables');
    expect(item?.at).toBe(FROM + 200);
  });

  it('says a session idling on background work is still running', () => {
    const task = {
      id: 'b1',
      kind: 'shell' as const,
      label: 'dev server',
      startedAt: FROM,
      endedAt: null,
      status: 'running' as const,
      exitCode: null,
      pid: null,
    };
    const s = state([finished('bg', FROM + 100, { background: [task] })]);
    const recap = selectRecap(SEEN, FROM, NOW)(s);
    expect(recap.finished).toEqual([]);
    expect(recap.running[0]?.detail).toBe('1 background task running');
  });
});

describe('hasNews', () => {
  it('needs something inside the window; running work alone is not news', () => {
    const running = session('busy', { kind: 'working' });
    const quiet = selectRecap(SEEN, FROM, NOW)(state([running]));
    expect(hasNews(quiet, FROM, NOW)).toBe(false);
    expect(isEmptyRecap(quiet)).toBe(false);
    const done = selectRecap(SEEN, FROM, NOW)(state([finished('done', FROM + 1)]));
    expect(hasNews(done, FROM, NOW)).toBe(true);
    expect(hasNews(done, FROM, FROM)).toBe(false);
  });
});

describe('selectDotMarks', () => {
  it('marks the dots and finished rows, never a waiting session or a failure', () => {
    const s = state(
      [
        finished('dot', FROM - 50),
        finished('row', FROM + 100, { status: { kind: 'ended' }, endedAt: FROM + 100 }),
        session('wait', { kind: 'waiting_input' }, { lastAssistantAt: FROM + 100 }),
      ],
      failedTerminal(),
    );
    expect(selectDotMarks(SEEN, FROM, NOW)(s)).toEqual({
      's:dot': FROM - 50,
      's:row': FROM + 100,
    });
  });
});
