import {
  type ClaudeSession,
  ClaudeSession as ClaudeSessionSchema,
  HookCommon,
  KnownHookEvent,
} from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { FIXTURE_SESSION_ID, type HookFixture, hookFixture } from './fixtures.test-helpers.js';
import { newSession, type SessionHookEvent, sessionReducer } from './session-reducer.js';

const T0 = 1_760_000_000_000;

function event(
  name: HookFixture,
  ts: number,
  overrides: Record<string, unknown> = {},
): SessionHookEvent {
  const raw = hookFixture(name, overrides);
  const known = KnownHookEvent.safeParse(raw);
  return { common: HookCommon.parse(raw), hook: known.success ? known.data : null, ts };
}

function run(...events: SessionHookEvent[]) {
  let session: ClaudeSession = {
    ...newSession(FIXTURE_SESSION_ID, T0),
    status: { kind: 'working' },
  };
  for (const e of events) session = sessionReducer(session, e);
  expect(ClaudeSessionSchema.safeParse(session).success).toBe(true);
  return session;
}

describe('background tasks from hooks', () => {
  it.each([
    ['post-tool-use-bash-background', 'shell', 'b7k2m9q4x', 'Watch the web build'],
    ['post-tool-use-monitor', 'monitor', 'm3r8t1w6z', 'Errors in the dev server log'],
    ['post-tool-use-agent-async', 'agent', 'a5c9e2f7b1d3', 'Find terminal names'],
  ] as const)('%s starts a running %s task', (fixture, kind, id, label) => {
    const session = run(event(fixture, T0 + 1000));
    expect(session.background).toEqual([
      expect.objectContaining({
        id,
        kind,
        label,
        status: 'running',
        startedAt: T0 + 1000,
        endedAt: null,
      }),
    ]);
    // A background launch hands control back: the session keeps working.
    expect(session.status.kind).toBe('working');
  });

  it('keeps the command as typed for shells, on one line in the label', () => {
    const session = run(
      event('post-tool-use-bash-background', T0, {
        tool_input: { command: 'pnpm   test\n  --watch', run_in_background: true },
      }),
    );
    expect(session.background?.[0]).toMatchObject({
      label: 'pnpm test --watch',
      command: 'pnpm   test\n  --watch',
      toolUseId: 'toolu_07BgShellStartAbCdEfGhIj',
    });
  });

  it('ignores foreground calls', () => {
    const foreground = run(
      event('post-tool-use-bash-background', T0, {
        tool_input: { command: 'pnpm test' },
        tool_response: { stdout: 'ok', stderr: '', interrupted: false },
      }),
      event('post-tool-use-agent-async', T0, { tool_response: { status: 'completed' } }),
    );
    expect(foreground.background ?? []).toEqual([]);
  });

  it('counts a command the timeout moved to the background', () => {
    const session = run(
      event('post-tool-use-bash-background', T0, {
        tool_input: { command: 'pnpm e2e', description: 'Run e2e' },
        tool_response: {
          stdout: '',
          stderr: '',
          backgroundTaskId: 'b9moved',
          timedOutAfterMs: 120000,
        },
      }),
    );
    expect(session.background?.[0]).toMatchObject({
      id: 'b9moved',
      kind: 'shell',
      label: 'Run e2e',
    });
  });

  it('falls back to the tool call id when the response has no task id', () => {
    const session = run(event('post-tool-use-bash-background', T0, { tool_response: {} }));
    expect(session.background?.[0]?.id).toBe('toolu_07BgShellStartAbCdEfGhIj');
  });

  it('records a launch that failed as an error', () => {
    const session = run(event('post-tool-use-failure-bash-background', T0 + 5));
    expect(session.background?.[0]).toMatchObject({
      kind: 'shell',
      status: 'error',
      endedAt: T0 + 5,
      label: 'Start the missing dev script',
    });
  });

  it('a Stop snapshot keeps listed tasks running and finishes the rest', () => {
    const session = run(
      event('post-tool-use-bash-background', T0),
      event('post-tool-use-monitor', T0 + 1),
      event('stop-background', T0 + 9000),
    );
    expect(session.background?.map((t) => [t.id, t.status, t.endedAt])).toEqual([
      ['b7k2m9q4x', 'running', null],
      ['m3r8t1w6z', 'done', T0 + 9000],
    ]);
    // The ambient housekeeping watcher isn't background work.
    expect(session.background?.some((t) => t.id === 'w0housekeep')).toBe(false);
    expect(session.status.kind).toBe('idle');
  });

  it('a Stop snapshot adopts a task keyed by its tool call', () => {
    const session = run(
      event('post-tool-use-bash-background', T0, { tool_response: {} }),
      event('stop-background', T0 + 10),
    );
    expect(session.background).toHaveLength(1);
    expect(session.background?.[0]).toMatchObject({ id: 'b7k2m9q4x', status: 'running' });
  });

  it('a Stop without a snapshot (older Claude Code) changes nothing', () => {
    const session = run(event('post-tool-use-bash-background', T0), event('stop', T0 + 10));
    expect(session.background?.[0]?.status).toBe('running');
  });

  it('an empty snapshot finishes every running task', () => {
    const session = run(
      event('post-tool-use-bash-background', T0),
      event('stop-background', T0 + 10, { background_tasks: [] }),
    );
    expect(session.background?.[0]).toMatchObject({ status: 'done', endedAt: T0 + 10 });
  });

  it('a malformed snapshot is skipped, not thrown on', () => {
    const session = run(
      event('post-tool-use-bash-background', T0),
      event('stop-background', T0 + 10, { background_tasks: 'nope' }),
    );
    expect(session.background?.[0]?.status).toBe('running');
  });

  it('an async agent names its subagent and finishes with it', () => {
    const session = run(
      event('post-tool-use-agent-async', T0),
      event('subagent-start', T0 + 1, { agent_id: 'agent-a5c9e2f7b1d3', agent_type: 'Explore' }),
    );
    expect(session.subagents[0]).toMatchObject({
      type: 'Explore',
      description: 'Find terminal names',
    });
    const done = sessionReducer(
      session,
      event('subagent-stop', T0 + 50, {
        agent_id: 'agent-a5c9e2f7b1d3',
        background_tasks: undefined,
      }),
    );
    expect(done.background?.[0]).toMatchObject({ kind: 'agent', status: 'done', endedAt: T0 + 50 });
    expect(done.subagents[0]?.status).toBe('done');
  });

  it('a foreground subagent takes its description from the Agent call in flight', () => {
    const session = run(
      event('pre-tool-use-bash', T0, {
        tool_name: 'Agent',
        tool_input: { description: 'Audit the cart', prompt: 'Read src/cart.ts' },
      }),
      event('subagent-start', T0 + 1),
    );
    expect(session.subagents[0]?.description).toBe('Audit the cart');
  });

  it.each([
    'post-tool-use-bash-background',
    'post-tool-use-monitor',
    'post-tool-use-agent-async',
  ] as const)('session end stops a running %s task', (fixture) => {
    const session = run(event(fixture, T0), event('session-end', T0 + 70));
    expect(session.background?.[0]).toMatchObject({ status: 'stopped', endedAt: T0 + 70 });
  });

  it('session end leaves finished tasks as they were', () => {
    const session = run(
      event('post-tool-use-failure-bash-background', T0),
      event('session-end', T0 + 70),
    );
    expect(session.background?.[0]).toMatchObject({ status: 'error', endedAt: T0 });
  });
});
