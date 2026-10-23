import { describe, expect, it } from 'vitest';
import {
  backgroundItems,
  backgroundLine,
  endedLabel,
  FINISHED_VISIBLE_MS,
  formatElapsed,
  groupBackground,
  runningBackground,
  runningHelpers,
} from './model.js';

const T = 1_760_000_000_000;
const task = (
  id: string,
  kind: 'shell' | 'monitor' | 'agent',
  status = 'running' as const,
  at = T,
) => ({
  id,
  kind,
  label: `${id} label`,
  startedAt: at,
  endedAt: status === 'running' ? null : at + 1,
  status,
  exitCode: null,
  pid: null,
});
const agent = (id: string, status: 'running' | 'done' = 'running', at = T) => ({
  id,
  type: 'Explore',
  description: 'find terminal names',
  status,
  startedAt: at,
  endedAt: status === 'running' ? null : at + 1,
});

describe('background items', () => {
  it('merges tasks and subagents, listing an async subagent once', () => {
    const session = {
      background: [task('b1', 'shell', 'running', T + 2), task('a1', 'agent', 'running', T + 3)],
      subagents: [agent('agent-a1', 'running', T + 3), agent('s9', 'running', T)],
    };
    const items = backgroundItems(session);
    expect(items.map((i) => [i.id, i.kind, i.label])).toEqual([
      ['s9', 'agent', 'Explore: find terminal names'],
      ['b1', 'shell', 'b1 label'],
      ['a1', 'agent', 'Explore: a1 label'],
    ]);
    expect(runningBackground(session)).toBe(3);
    expect(runningHelpers(session)).toEqual(['shell']);
    expect(backgroundLine(items)).toBe('3 running: b1 label · Explore: a1 label');
  });

  it('works for sessions from before background tracking', () => {
    expect(backgroundItems({ subagents: [] })).toEqual([]);
    expect(runningBackground({ subagents: [] })).toBe(0);
    expect(backgroundLine([])).toBeNull();
  });

  it('keeps finished items for two minutes, then folds them', () => {
    const items = backgroundItems({
      background: [
        task('old', 'shell', 'done' as never, T),
        task('new', 'monitor', 'done' as never, T + 60_000),
        task('run', 'shell'),
      ],
      subagents: [],
    });
    const groups = groupBackground(items, T + FINISHED_VISIBLE_MS + 30_000);
    expect(groups.running.map((i) => i.id)).toEqual(['run']);
    expect(groups.recent.map((i) => i.id)).toEqual(['new']);
    expect(groups.folded).toBe(1);
  });
});

describe('formatting', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(42_900)).toBe('0:42');
    expect(formatElapsed(725_000)).toBe('12:05');
    expect(formatElapsed(3_729_000)).toBe('1:02:09');
    expect(formatElapsed(-5)).toBe('0:00');
  });

  it('labels finished items with text, not color alone', () => {
    expect(endedLabel({ status: 'done', exitCode: 0 })).toBe('Done');
    expect(endedLabel({ status: 'error', exitCode: 2 })).toBe('Exit 2');
    expect(endedLabel({ status: 'error', exitCode: null })).toBe('Failed');
    expect(endedLabel({ status: 'stopped', exitCode: null })).toBe('Stopped');
  });
});
