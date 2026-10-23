import { describe, expect, it } from 'vitest';
import {
  applyTaskNotifications,
  backgroundKindOf,
  backgroundLabel,
  backgroundLaunchKind,
  endBackground,
  exitCodeOf,
  parseLiveTasks,
  parseTaskNotifications,
  sameTaskId,
  startBackground,
  stopAllBackground,
} from './background.js';
import { BackgroundTask, MAX_BACKGROUND_TASKS } from './domain.js';

const T = 1_760_000_000_000;
const shell = (id: string, ts = T) =>
  startBackground([], {
    id,
    kind: 'shell',
    label: id,
    command: `run ${id}`,
    ts,
  })[0] as BackgroundTask;

describe('backgroundLaunchKind', () => {
  it.each([
    ['Bash', { command: 'x', run_in_background: true }, undefined, 'shell'],
    ['PowerShell', { command: 'x', run_in_background: true }, undefined, 'shell'],
    ['Bash', { command: 'x' }, { backgroundTaskId: 'b1' }, 'shell'],
    ['Bash', { command: 'x' }, { stdout: 'ok' }, null],
    ['Monitor', { command: 'tail -f x', description: 'd' }, undefined, 'monitor'],
    ['Agent', { prompt: 'p', run_in_background: true }, undefined, 'agent'],
    ['Agent', { prompt: 'p' }, { status: 'async_launched', agentId: 'a1' }, 'agent'],
    ['Task', { prompt: 'p' }, { status: 'completed' }, null],
    ['Read', { file_path: 'a' }, undefined, null],
    ['Bash', 'not an object', null, null],
  ])('%s %j %j → %s', (tool, input, response, kind) => {
    expect(backgroundLaunchKind(tool, input, response)).toBe(kind);
  });
});

describe('labels and kinds', () => {
  it('prefers the description, then the command, on one clipped line', () => {
    expect(backgroundLabel({ description: 'Watch', command: 'x' })).toBe('Watch');
    expect(backgroundLabel({ command: 'a\n  b' })).toBe('a b');
    expect(backgroundLabel({ ws: { url: 'wss://example.test/feed' } })).toBe(
      'wss://example.test/feed',
    );
    expect(backgroundLabel(null)).toBe('Background task');
    expect(backgroundLabel({ command: 'y'.repeat(500) })).toHaveLength(120);
  });

  it('maps Claude Code task types', () => {
    expect(backgroundKindOf('local_bash')).toBe('shell');
    expect(backgroundKindOf('shell')).toBe('shell');
    expect(backgroundKindOf('monitor')).toBe('monitor');
    expect(backgroundKindOf('local_agent')).toBe('agent');
    expect(backgroundKindOf('subagent')).toBe('agent');
    expect(backgroundKindOf('local_workflow')).toBe('other');
    expect(backgroundKindOf(undefined)).toBe('other');
  });

  it('compares agent ids with or without the agent- prefix', () => {
    expect(sameTaskId('agent-abc', 'abc')).toBe(true);
    expect(sameTaskId('abc', 'abd')).toBe(false);
  });
});

describe('start and end', () => {
  it('validates, dedupes and caps the list, dropping finished tasks first', () => {
    let list = [shell('keep')];
    list = startBackground(list, { id: 'keep', kind: 'shell', label: 'again', ts: T });
    expect(list).toHaveLength(1);
    list = [endBackground(shell('old'), { status: 'done', ts: T + 1 }), ...list];
    for (let i = 0; i < MAX_BACKGROUND_TASKS; i++) {
      list = startBackground(list, { id: `t${i}`, kind: 'other', label: 'x', ts: T + i });
    }
    expect(list).toHaveLength(MAX_BACKGROUND_TASKS);
    expect(list.some((t) => t.id === 'old')).toBe(false);
    for (const task of list) expect(BackgroundTask.safeParse(task).success).toBe(true);
  });

  it('ends once, but a later report can add the exit code', () => {
    const done = endBackground(shell('a'), { status: 'done', ts: T + 5 });
    expect(done).toMatchObject({ status: 'done', endedAt: T + 5, exitCode: null });
    const failed = endBackground(done, { status: 'error', ts: T + 9, exitCode: 2, tail: 'exit 2' });
    expect(failed).toMatchObject({ status: 'error', endedAt: T + 5, exitCode: 2, tail: 'exit 2' });
    expect(endBackground(failed, { status: 'done', ts: T + 20, exitCode: 0 })).toBe(failed);
  });

  it('stops only running tasks, and returns the same list when none run', () => {
    const list = [shell('a'), endBackground(shell('b'), { status: 'error', ts: T + 1 })];
    const stopped = stopAllBackground(list, T + 9);
    expect(stopped.map((t) => t.status)).toEqual(['stopped', 'error']);
    expect(stopAllBackground(stopped, T + 10)).toBe(stopped);
  });
});

describe('parseLiveTasks', () => {
  it('reads hook and SDK shapes, skipping bad and finished entries', () => {
    expect(
      parseLiveTasks([
        { id: 'b1', type: 'shell', status: 'running', description: 'Watch', command: 'w' },
        { task_id: 'a1', task_type: 'local_agent', description: 'Explore' },
        { id: 'm1', type: 'monitor', ambient: true, description: 'live' },
        { id: 'x', status: 'completed' },
        { type: 'shell' },
        42,
      ]),
    ).toEqual([
      { id: 'b1', kind: 'shell', label: 'Watch', command: 'w', ambient: false },
      { id: 'a1', kind: 'agent', label: 'Explore', command: null, ambient: false },
      { id: 'm1', kind: 'monitor', label: 'live', command: null, ambient: true },
    ]);
    expect(parseLiveTasks(undefined)).toBeNull();
  });
});

describe('task notifications', () => {
  const text = [
    'Some text',
    '<task-notification>',
    '<task-id>b1</task-id>',
    '<status>completed</status>',
    '<summary>Background command "Build" completed (exit code 0)</summary>',
    '</task-notification>',
    '<task-notification><task-id>b2</task-id><status>failed</status>',
    '<summary>Background command "Lint" failed with exit code 1</summary></task-notification>',
    '<task-notification><task-id>b3</task-id><status>killed</status></task-notification>',
    '<task-notification><status>completed</status></task-notification>',
  ].join('\n');

  it('parses id, status, exit code and summary', () => {
    expect(parseTaskNotifications(text)).toEqual([
      {
        id: 'b1',
        status: 'done',
        exitCode: 0,
        summary: 'Background command "Build" completed (exit code 0)',
      },
      {
        id: 'b2',
        status: 'error',
        exitCode: 1,
        summary: 'Background command "Lint" failed with exit code 1',
      },
      { id: 'b3', status: 'stopped', exitCode: null, summary: null },
    ]);
    expect(parseTaskNotifications('no tags here')).toEqual([]);
    expect(exitCodeOf('exit code: 137')).toBe(137);
    expect(exitCodeOf(null)).toBeNull();
  });

  it('finishes known tasks and ignores the rest', () => {
    const list = [shell('b1'), shell('b2')];
    const next = applyTaskNotifications(list, parseTaskNotifications(text), T + 100);
    expect(next.map((t) => [t.id, t.status, t.exitCode])).toEqual([
      ['b1', 'done', 0],
      ['b2', 'error', 1],
    ]);
    expect(next[0]?.tail).toContain('completed');
    expect(applyTaskNotifications(next, [], T)).toBe(next);
  });
});
