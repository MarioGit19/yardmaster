import { describe, expect, it } from 'vitest';
import {
  ActivityEvent,
  Approval,
  BoardState,
  ClaudeSession,
  EditorWindow,
  Execution,
  emptyBoardState,
  GitInfo,
  isArchivedSession,
  PortBinding,
  ProcessStats,
  Project,
  SessionStatus,
  Terminal,
  ToolActivity,
  terminalReplyBlock,
} from './domain.js';
import {
  approval,
  board,
  editorWindow,
  execution,
  port,
  project,
  session,
  T0,
  terminal,
} from './fixtures.test-helpers.js';

describe('domain schemas accept valid samples', () => {
  it.each([
    ['Project', Project, project],
    ['GitInfo', GitInfo, project.git],
    ['EditorWindow', EditorWindow, editorWindow],
    ['Terminal', Terminal, terminal],
    ['ProcessStats', ProcessStats, terminal.stats],
    ['Execution', Execution, execution],
    ['ClaudeSession', ClaudeSession, session],
    ['ToolActivity', ToolActivity, session.currentTool],
    ['Approval', Approval, approval],
    ['PortBinding', PortBinding, port],
    ['BoardState', BoardState, board],
  ] as const)('%s', (_name, schema, sample) => {
    expect(schema.safeParse(sample).success).toBe(true);
  });

  it('accepts an empty board', () => {
    expect(BoardState.safeParse(emptyBoardState()).success).toBe(true);
  });

  it('accepts an activity event', () => {
    const event = {
      id: 'evt-1',
      ts: T0,
      kind: 'tool.start',
      projectId: project.id,
      sessionId: session.id,
      terminalId: null,
      execId: null,
      summary: 'Edit src/cart.ts',
      data: { tool: 'Edit' },
    };
    expect(ActivityEvent.safeParse(event).success).toBe(true);
  });
});

describe('domain schemas reject invalid samples', () => {
  it.each([
    ['Project without path', Project, { ...project, path: '' }],
    ['Project with out-of-range accent', Project, { ...project, accent: 10 }],
    ['Project with a fractional timestamp', Project, { ...project, createdAt: 1.5 }],
    ['GitInfo with negative dirty count', GitInfo, { ...project.git, dirty: -1 }],
    [
      'EditorWindow with non-string folder',
      EditorWindow,
      { ...editorWindow, workspaceFolders: [1] },
    ],
    ['Terminal with unknown state', Terminal, { ...terminal, state: 'zombie' }],
    ['Terminal with pid 0', Terminal, { ...terminal, shellPid: 0 }],
    ['Execution with unknown confidence', Execution, { ...execution, confidence: 'certain' }],
    ['Execution missing commandLine', Execution, { ...execution, commandLine: undefined }],
    ['ClaudeSession with unknown origin', ClaudeSession, { ...session, origin: 'cloud' }],
    [
      'ClaudeSession with bad permission mode',
      ClaudeSession,
      { ...session, permissionMode: 'yolo' },
    ],
    [
      'ClaudeSession with negative tokens',
      ClaudeSession,
      { ...session, tokens: { ...session.tokens, input: -5 } },
    ],
    ['ToolActivity with unknown family', ToolActivity, { ...session.currentTool, family: 'magic' }],
    ['Approval with unknown state', Approval, { ...approval, state: 'maybe' }],
    ['PortBinding with port 70000', PortBinding, { ...port, port: 70_000 }],
    ['ActivityEvent with unknown kind', ActivityEvent, { id: 'e', ts: T0, kind: 'nope' }],
    ['non-object', Project, 'acme-shop'],
  ] as const)('%s', (_name, schema, sample) => {
    expect(schema.safeParse(sample).success).toBe(false);
  });

  it('rejects a board whose map key does not match the item id', () => {
    const bad = { ...board, terminals: { 'other-id': terminal } };
    const result = BoardState.safeParse(bad);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['terminals', 'other-id']);
  });

  it('rejects a board missing a collection', () => {
    const { ports: _ports, ...rest } = board;
    expect(BoardState.safeParse(rest).success).toBe(false);
  });
});

describe('SessionStatus', () => {
  it.each([
    { kind: 'idle' },
    { kind: 'working' },
    { kind: 'tool', tool: 'Bash', toolUseId: null },
    { kind: 'waiting_permission', approvalId: 'appr-1' },
    { kind: 'waiting_input' },
    { kind: 'error', message: 'rate limited' },
    { kind: 'ended' },
    { kind: 'unknown', alive: true },
    { kind: 'compacting', previous: { kind: 'tool', tool: 'Read', toolUseId: 'toolu_9' } },
  ])('accepts $kind', (status) => {
    expect(SessionStatus.safeParse(status).success).toBe(true);
  });

  it.each([
    ['unknown kind', { kind: 'sleeping' }],
    ['tool without name', { kind: 'tool', tool: '', toolUseId: null }],
    ['unknown without alive flag', { kind: 'unknown' }],
    ['compacting from ended', { kind: 'compacting', previous: { kind: 'ended' } }],
    [
      'nested compacting',
      { kind: 'compacting', previous: { kind: 'compacting', previous: { kind: 'idle' } } },
    ],
  ])('rejects %s', (_name, status) => {
    expect(SessionStatus.safeParse(status).success).toBe(false);
  });
});

describe('terminalReplyBlock', () => {
  const at = (status: SessionStatus) => ({
    origin: 'terminal' as const,
    terminalId: 't-1',
    status,
  });

  it.each([{ kind: 'idle' }, { kind: 'waiting_input' }] as SessionStatus[])(
    'allows a linked terminal session that is $kind',
    (status) => {
      expect(terminalReplyBlock(at(status))).toBeNull();
    },
  );

  it('takes a reply after a usage limit: Claude is back at its prompt', () => {
    const limited: SessionStatus = { kind: 'error', message: null, reason: 'rate_limit' };
    expect(terminalReplyBlock(at(limited))).toBeNull();
  });

  it.each([
    { kind: 'working' },
    { kind: 'tool', tool: 'Bash', toolUseId: null },
    { kind: 'waiting_permission', approvalId: null },
    { kind: 'compacting', previous: { kind: 'idle' } },
    { kind: 'unknown', alive: true },
    { kind: 'error', message: null },
    { kind: 'ended' },
  ] as SessionStatus[])('refuses a session that is $kind', (status) => {
    expect(terminalReplyBlock(at(status))).toBe('session_busy');
  });

  it('refuses board sessions and unlinked terminal sessions', () => {
    const idle: SessionStatus = { kind: 'idle' };
    expect(terminalReplyBlock({ origin: 'board', terminalId: null, status: idle })).toBe(
      'not_terminal_session',
    );
    expect(terminalReplyBlock({ origin: 'terminal', terminalId: null, status: idle })).toBe(
      'no_linked_terminal',
    );
  });
});

describe('isArchivedSession', () => {
  const ended = { status: { kind: 'ended' as const }, endedAt: 100 };

  it('holds until the session runs again', () => {
    expect(isArchivedSession({ ...ended, archivedAt: 200 })).toBe(true);
    expect(isArchivedSession({ ...ended, archivedAt: null })).toBe(false);
    expect(isArchivedSession({ status: { kind: 'idle' }, endedAt: null, archivedAt: 200 })).toBe(
      false,
    );
  });

  it('lets go when a resumed session ends again', () => {
    expect(isArchivedSession({ ...ended, endedAt: 300, archivedAt: 200 })).toBe(false);
  });
});
