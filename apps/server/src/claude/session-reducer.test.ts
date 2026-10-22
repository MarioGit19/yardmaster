import {
  type ClaudeSession,
  ClaudeSession as ClaudeSessionSchema,
  HookCommon,
  KnownHookEvent,
  type SessionStatus,
} from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { FIXTURE_SESSION_ID, type HookFixture, hookFixture } from './fixtures.test-helpers.js';
import {
  MAX_SUBAGENTS,
  newSession,
  type SessionHookEvent,
  sessionReducer,
} from './session-reducer.js';

const T0 = 1_760_000_000_000;

function event(
  name: HookFixture,
  overrides: Record<string, unknown> = {},
  extra: Partial<SessionHookEvent> = {},
): SessionHookEvent {
  const raw = hookFixture(name, overrides);
  const known = KnownHookEvent.safeParse(raw);
  return {
    common: HookCommon.parse(raw),
    hook: known.success ? known.data : null,
    ts: T0 + 1000,
    ...extra,
  };
}

function inStatus(status: SessionStatus, fields: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    ...newSession(FIXTURE_SESSION_ID, T0),
    cwd: '/home/dev/acme-shop',
    status,
    ...(status.kind === 'ended' ? { endedAt: T0 } : {}),
    ...fields,
  };
}

const idle: SessionStatus = { kind: 'idle' };
const working: SessionStatus = { kind: 'working' };
const bash: SessionStatus = {
  kind: 'tool',
  tool: 'Bash',
  toolUseId: 'toolu_01AbCdEfGhIjKlMnOpQrStUv',
};
const permission: SessionStatus = { kind: 'waiting_permission', approvalId: null };
const waitingInput: SessionStatus = { kind: 'waiting_input' };
const error: SessionStatus = { kind: 'error', message: 'Overloaded' };
const ended: SessionStatus = { kind: 'ended' };
const unknown: SessionStatus = { kind: 'unknown', alive: true };
const compactingWorking: SessionStatus = { kind: 'compacting', previous: working };

type Row = [
  label: string,
  from: SessionStatus | null,
  fixture: HookFixture,
  overrides: Record<string, unknown>,
  to: SessionStatus,
];

// PRD §4.2, one row per transition (and per guarded non-transition).
const TRANSITIONS: Row[] = [
  ['(none) -SessionStart-> idle', null, 'session-start', {}, idle],
  ['unknown -SessionStart-> idle', unknown, 'session-start', {}, idle],
  ['ended -SessionStart(resume)-> idle', ended, 'session-start', { source: 'resume' }, idle],
  ['error -SessionStart(clear)-> idle', error, 'session-start', { source: 'clear' }, idle],
  [
    'compacting -SessionStart(compact)-> compacting',
    compactingWorking,
    'session-start',
    { source: 'compact' },
    compactingWorking,
  ],
  ['idle -UserPromptSubmit-> working', idle, 'user-prompt-submit', {}, working],
  ['waiting_input -UserPromptSubmit-> working', waitingInput, 'user-prompt-submit', {}, working],
  ['error -UserPromptSubmit-> working', error, 'user-prompt-submit', {}, working],
  ['(none) -UserPromptSubmit-> working', null, 'user-prompt-submit', {}, working],
  ['ended -UserPromptSubmit-> ended', ended, 'user-prompt-submit', {}, ended],
  ['working -PreToolUse-> tool', working, 'pre-tool-use-bash', {}, bash],
  ['unknown -PreToolUse-> tool', unknown, 'pre-tool-use-bash', {}, bash],
  [
    'tool -PreToolUse(next)-> tool',
    bash,
    'pre-tool-use-edit',
    {},
    {
      kind: 'tool',
      tool: 'Edit',
      toolUseId: 'toolu_02AbCdEfGhIjKlMnOpQrStUv',
    },
  ],
  ['ended -PreToolUse-> ended', ended, 'pre-tool-use-bash', {}, ended],
  [
    'tool -PostToolUse(same id)-> working',
    bash,
    'post-tool-use',
    { tool_use_id: 'toolu_01AbCdEfGhIjKlMnOpQrStUv' },
    working,
  ],
  [
    'tool -PostToolUse(no id)-> working',
    bash,
    'post-tool-use',
    { tool_use_id: undefined },
    working,
  ],
  ['tool -PostToolUse(other id)-> tool', bash, 'post-tool-use', {}, bash],
  [
    'tool -PostToolUseFailure-> working',
    bash,
    'post-tool-use-failure',
    { tool_use_id: 'toolu_01AbCdEfGhIjKlMnOpQrStUv' },
    working,
  ],
  ['waiting_permission -PostToolUse-> working', permission, 'post-tool-use', {}, working],
  [
    'waiting_permission -PostToolUseFailure(denied)-> working',
    permission,
    'post-tool-use-failure',
    {},
    working,
  ],
  ['working -PostToolUse-> working', working, 'post-tool-use', {}, working],
  ['idle -PostToolUse(late)-> idle', idle, 'post-tool-use', {}, idle],
  ['ended -PostToolUse(late)-> ended', ended, 'post-tool-use', {}, ended],
  [
    'working -Notification(permission_prompt)-> waiting_permission',
    working,
    'notification-permission',
    {},
    permission,
  ],
  [
    'tool -Notification(permission_prompt)-> waiting_permission',
    bash,
    'notification-permission',
    {},
    permission,
  ],
  ['tool -PermissionRequest-> waiting_permission', bash, 'permission-request', {}, permission],
  ['ended -PermissionRequest-> ended', ended, 'permission-request', {}, ended],
  ['idle -Notification(idle_prompt)-> waiting_input', idle, 'notification-idle', {}, waitingInput],
  [
    'working -Notification(other)-> working',
    working,
    'notification-idle',
    { notification_type: 'auth_success' },
    working,
  ],
  ['ended -Notification(idle_prompt)-> ended', ended, 'notification-idle', {}, ended],
  ['working -Stop-> idle', working, 'stop', {}, idle],
  ['tool -Stop-> idle', bash, 'stop', {}, idle],
  ['waiting_permission -Stop-> idle', permission, 'stop', {}, idle],
  ['ended -Stop-> ended', ended, 'stop', {}, ended],
  [
    'working -StopFailure-> error',
    working,
    'stop-failure',
    {},
    { kind: 'error', message: 'Rate limit reached' },
  ],
  ['ended -StopFailure-> ended', ended, 'stop-failure', {}, ended],
  ['working -PreCompact-> compacting', working, 'pre-compact', {}, compactingWorking],
  [
    'idle -PreCompact-> compacting',
    idle,
    'pre-compact',
    { trigger: 'manual' },
    { kind: 'compacting', previous: idle },
  ],
  ['compacting -PreCompact-> compacting', compactingWorking, 'pre-compact', {}, compactingWorking],
  ['ended -PreCompact-> ended', ended, 'pre-compact', {}, ended],
  ['compacting -PostCompact-> previous (working)', compactingWorking, 'post-compact', {}, working],
  [
    'compacting -PostCompact-> previous (waiting_input)',
    { kind: 'compacting', previous: waitingInput },
    'post-compact',
    {},
    waitingInput,
  ],
  ['idle -PostCompact-> idle', idle, 'post-compact', {}, idle],
  ['working -SessionEnd-> ended', working, 'session-end', {}, ended],
  ['tool -SessionEnd-> ended', bash, 'session-end', {}, ended],
  ['compacting -SessionEnd-> ended', compactingWorking, 'session-end', {}, ended],
  ['(none) -SessionEnd-> ended', null, 'session-end', {}, ended],
  ['working -SubagentStart-> working', working, 'subagent-start', {}, working],
  ['working -SubagentStop-> working', working, 'subagent-stop', {}, working],
  ['unknown -FutureEvent-> unknown', unknown, 'unknown-event', {}, unknown],
  ['working -FutureEvent-> working', working, 'unknown-event', {}, working],
];

describe('sessionReducer transitions', () => {
  it.each(TRANSITIONS)('%s', (_label, from, fixture, overrides, to) => {
    const before = from ? inStatus(from) : undefined;
    const after = sessionReducer(before, event(fixture, overrides));
    expect(after.status).toEqual(to);
    expect(ClaudeSessionSchema.safeParse(after).success).toBe(true);
  });

  it('covers every hook event name', () => {
    const covered = new Set(
      TRANSITIONS.map(([, , fixture]) => event(fixture).common.hook_event_name),
    );
    for (const name of KnownHookEvent.options.map((o) => o.shape.hook_event_name.value)) {
      expect(covered).toContain(name);
    }
  });
});

describe('sessionReducer fields', () => {
  it('creates a terminal session from the common fields', () => {
    const session = sessionReducer(
      undefined,
      event('session-start', {}, { claudePid: 4321, projectId: 'a1b2c3d4e5f6' }),
    );
    expect(session).toMatchObject({
      id: FIXTURE_SESSION_ID,
      origin: 'terminal',
      projectId: 'a1b2c3d4e5f6',
      cwd: '/home/dev/acme-shop',
      model: 'claude-sonnet-5-5',
      permissionMode: 'default',
      claudePid: 4321,
      transcriptPath: expect.stringContaining('.jsonl'),
      startedAt: T0 + 1000,
      updatedAt: T0 + 1000,
      endedAt: null,
    });
  });

  it('keeps known fields when a later event omits them', () => {
    const start = sessionReducer(undefined, event('session-start', {}, { claudePid: 4321 }));
    const next = sessionReducer(
      start,
      event('user-prompt-submit', { permission_mode: 'not-a-mode', cwd: undefined }),
    );
    expect(next).toMatchObject({
      permissionMode: 'default',
      cwd: '/home/dev/acme-shop',
      claudePid: 4321,
      model: 'claude-sonnet-5-5',
    });
  });

  it('tracks permission mode changes', () => {
    const next = sessionReducer(inStatus(working), event('pre-tool-use-edit'));
    expect(next.permissionMode).toBe('acceptEdits');
  });

  it('titles the session from its first prompt only', () => {
    const first = sessionReducer(inStatus(idle), event('user-prompt-submit'));
    expect(first.title).toBe('Refactor the cart totals into a pure function');
    const second = sessionReducer(first, event('user-prompt-submit', { prompt: 'Now add tests' }));
    expect(second.title).toBe('Refactor the cart totals into a pure function');
  });

  it('records the current tool with a short input summary', () => {
    const bashRun = sessionReducer(inStatus(working), event('pre-tool-use-bash'));
    expect(bashRun.currentTool).toEqual({
      id: 'toolu_01AbCdEfGhIjKlMnOpQrStUv',
      sessionId: FIXTURE_SESSION_ID,
      tool: 'Bash',
      family: 'bash',
      summary: 'pnpm test',
      startedAt: T0 + 1000,
      endedAt: null,
      status: 'running',
    });

    const edit = sessionReducer(bashRun, event('pre-tool-use-edit'));
    expect(edit.currentTool).toMatchObject({
      tool: 'Edit',
      family: 'edit',
      summary: 'src/cart.ts',
    });

    const grep = sessionReducer(
      inStatus(working),
      event('pre-tool-use-bash', {
        tool_name: 'Grep',
        tool_input: { pattern: 'cartTotal\n  ' },
        tool_use_id: undefined,
      }),
    );
    expect(grep.currentTool).toMatchObject({ family: 'search', summary: 'cartTotal' });
    expect(grep.currentTool?.id).toBeTruthy();

    const mcp = sessionReducer(
      inStatus(working),
      event('pre-tool-use-bash', { tool_name: 'mcp__docs__lookup', tool_input: { limit: 3 } }),
    );
    expect(mcp.currentTool).toMatchObject({ family: 'other', summary: null });
  });

  it('keeps the tool while waiting for permission and clears it once work resumes', () => {
    const running = sessionReducer(inStatus(working), event('pre-tool-use-bash'));
    const waiting = sessionReducer(running, event('notification-permission'));
    expect(waiting.currentTool?.tool).toBe('Bash');
    const done = sessionReducer(waiting, event('post-tool-use'));
    expect(done.status).toEqual(working);
    expect(done.currentTool).toBeNull();
  });

  it('records the last assistant message on Stop', () => {
    const session = sessionReducer(inStatus(working), event('stop'));
    expect(session.lastAssistantText).toBe('Cart totals are now computed in one place.');
    const later = sessionReducer(session, event('stop', { last_assistant_message: '   ' }));
    expect(later.lastAssistantText).toBe('Cart totals are now computed in one place.');
  });

  it('clips very long assistant messages', () => {
    const long = 'x'.repeat(10_000);
    const session = sessionReducer(
      inStatus(working),
      event('stop', { last_assistant_message: long }),
    );
    expect(session.lastAssistantText?.length).toBeLessThanOrEqual(4_000);
    expect(session.lastAssistantText?.endsWith('…')).toBe(true);
  });

  it('records the error on StopFailure, falling back to the error code', () => {
    const detailed = sessionReducer(inStatus(working), event('stop-failure'));
    expect(detailed.status).toEqual({ kind: 'error', message: 'Rate limit reached' });
    const bare = sessionReducer(
      inStatus(working),
      event('stop-failure', { error_details: undefined }),
    );
    expect(bare.status).toEqual({ kind: 'error', message: 'rate_limit' });
    const none = sessionReducer(
      inStatus(working),
      event('stop-failure', { error: undefined, error_details: undefined }),
    );
    expect(none.status).toEqual({ kind: 'error', message: null });
  });

  it('sets endedAt on SessionEnd and clears it on resume', () => {
    const endedSession = sessionReducer(inStatus(working), event('session-end'));
    expect(endedSession.endedAt).toBe(T0 + 1000);
    const again = sessionReducer(endedSession, event('session-end', {}, { ts: T0 + 5000 }));
    expect(again.endedAt).toBe(T0 + 1000);
    const resumed = sessionReducer(
      again,
      event('session-start', { source: 'resume' }, { ts: T0 + 9000 }),
    );
    expect(resumed.endedAt).toBeNull();
    expect(resumed.status).toEqual(idle);
  });

  it('tracks subagents by id', () => {
    const started = sessionReducer(inStatus(working), event('subagent-start'));
    expect(started.subagents).toEqual([
      {
        id: 'agent-7c1d2e3f',
        type: 'Explore',
        description: null,
        status: 'running',
        startedAt: T0 + 1000,
        endedAt: null,
      },
    ]);
    const duplicate = sessionReducer(started, event('subagent-start'));
    expect(duplicate.subagents).toHaveLength(1);
    const stopped = sessionReducer(duplicate, event('subagent-stop', {}, { ts: T0 + 3000 }));
    expect(stopped.subagents[0]).toMatchObject({ status: 'done', endedAt: T0 + 3000 });
  });

  it('closes the oldest running subagent of the type when the stop has no id', () => {
    let session = inStatus(working);
    session = sessionReducer(session, event('subagent-start', { agent_id: 'agent-a' }));
    session = sessionReducer(session, event('subagent-start', { agent_id: 'agent-b' }));
    session = sessionReducer(session, event('subagent-stop', { agent_id: undefined }));
    expect(session.subagents.map((agent) => agent.status)).toEqual(['done', 'running']);
  });

  it('caps the subagent list', () => {
    let session = inStatus(working);
    for (let i = 0; i < MAX_SUBAGENTS + 5; i++) {
      session = sessionReducer(session, event('subagent-start', { agent_id: `agent-${i}` }));
    }
    expect(session.subagents).toHaveLength(MAX_SUBAGENTS);
    expect(session.subagents.at(-1)?.id).toBe(`agent-${MAX_SUBAGENTS + 4}`);
  });

  it('never mutates its input and never moves updatedAt backwards', () => {
    const before = inStatus(bash, { updatedAt: T0 + 50_000 });
    const snapshot = structuredClone(before);
    const after = sessionReducer(before, event('stop'));
    expect(before).toEqual(snapshot);
    expect(after.updatedAt).toBe(T0 + 50_000);
  });
});
