import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Options,
  type PermissionUpdate,
  query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ActivityEvent, ClaudeSession, Project, ServerToUi } from '@c-board/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardStore } from '../store.js';
import {
  MessageQueue,
  NOT_RUNNING,
  RESOLVED_APPROVAL_TTL_MS,
  SESSION_LIVE,
  SessionRunner,
  UNKNOWN_APPROVAL,
  UNKNOWN_PROJECT,
  UNKNOWN_SESSION,
} from './runner.js';
import { TranscriptService } from './transcript-service.js';

// Tests never reach the real SDK (or the API): `query` is a scripted fake.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const PROJECT: Project = {
  id: 'proj-acme',
  path: '/home/dev/acme-shop',
  name: 'acme-shop',
  accent: 2,
  source: 'manual',
  git: null,
  createdAt: 1_700_000_000_000,
  lastActivityAt: null,
};
const SESSION_A = '0b7e5c1d-2f3a-4b6c-8d9e-1a2b3c4d5e6f';
const SESSION_B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const logger = { warn: () => {}, debug: () => {} };

/** One scripted `query()` call: the test emits SDK messages and reads the prompts sent. */
interface FakeQuery {
  options: Options;
  prompts: SDKUserMessage[];
  emit(message: unknown): void;
  fail(error: Error): void;
  finish(): void;
  interrupt: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let queries: FakeQuery[];
let dir: string;
let ids: string[];
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  queries = [];
  ids = [];
  dir = await mkdtemp(join(tmpdir(), 'c-board-runner-'));
  vi.mocked(query).mockImplementation(({ prompt, options }) => {
    const outbox = new MessageQueue<{ message?: unknown; error?: Error }>();
    const fake: FakeQuery = {
      options: options ?? {},
      prompts: [],
      emit: (message) => outbox.push({ message }),
      fail: (error) => outbox.push({ error }),
      finish: () => outbox.end(),
      interrupt: vi.fn(async () => undefined),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      close: vi.fn(() => outbox.end()),
    };
    queries.push(fake);
    void (async () => {
      for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
        fake.prompts.push(message);
      }
    })();
    const generator = (async function* () {
      for await (const item of outbox) {
        if (item.error) throw item.error;
        yield item.message as never;
      }
    })();
    return Object.assign(generator, {
      interrupt: fake.interrupt,
      setModel: fake.setModel,
      setPermissionMode: fake.setPermissionMode,
      close: fake.close,
    }) as unknown as ReturnType<typeof query>;
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.mocked(query).mockReset();
  await rm(dir, { recursive: true, force: true });
});

function setup(options: { draftIntervalMs?: number; approvalTimeoutMs?: number } = {}) {
  const store = new BoardStore();
  store.upsertProject(PROJECT);
  const transcripts = new TranscriptService({
    store,
    logger,
    loadHistory: null,
    watchFile: () => async () => {},
    claudeConfigDir: join(dir, 'claude'),
  });
  let n = 0;
  const messages: ServerToUi[] = [];
  const events: ActivityEvent[] = [];
  const runner = new SessionRunner({
    store,
    transcripts,
    logger,
    onMessage: (message) => messages.push(message),
    onActivity: (event) => events.push(event),
    ...(options.approvalTimeoutMs !== undefined
      ? { approvalTimeoutMs: options.approvalTimeoutMs }
      : {}),
    newId: () => {
      const id = n === 0 ? SESSION_A : `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      n += 1;
      ids.push(id);
      return id;
    },
    draftIntervalMs: options.draftIntervalMs ?? 0,
  });
  cleanups.push(async () => {
    await runner.closeAll();
    await transcripts.close();
  });
  return { store, transcripts, runner, messages, events };
}

const session = (store: BoardStore, id: string): ClaudeSession => {
  const found = store.state.sessions[id];
  if (!found) throw new Error(`no session ${id}`);
  return found;
};

/** Lets the runner's consume loop and the transcript queue catch up. */
async function settle(transcripts?: TranscriptService) {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  await transcripts?.idle();
}

const assistant = (uuid: string, content: unknown[], id = `msg_${uuid}`) => ({
  type: 'assistant',
  uuid,
  session_id: SESSION_A,
  parent_tool_use_id: null,
  message: {
    id,
    model: 'claude-sonnet-5-5',
    role: 'assistant',
    content,
    usage: { input_tokens: 10, output_tokens: 5 },
  },
});
const result = (overrides: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done.',
  uuid: 'res-1',
  session_id: SESSION_A,
  ...overrides,
});
const state = (value: 'idle' | 'running' | 'requires_action') => ({
  type: 'system',
  subtype: 'session_state_changed',
  state: value,
  uuid: `state-${value}`,
  session_id: SESSION_A,
});
const textOf = (transcripts: TranscriptService, id: string) =>
  transcripts.messages(id).map((m) => `${m.kind}:${'text' in m ? m.text : ''}`);

describe('SessionRunner start', () => {
  it('starts a board session in the project with streaming input and partial messages', async () => {
    const { store, transcripts, runner } = setup();
    const started = await runner.startSession({
      projectId: PROJECT.id,
      prompt: 'Add a cart badge\nwith the item count',
      model: 'claude-opus-5-5',
      permissionMode: 'acceptEdits',
    });
    expect(started).toEqual({ ok: true, sessionId: SESSION_A });
    expect(query).toHaveBeenCalledTimes(1);

    const [q] = queries;
    expect(q?.options).toMatchObject({
      cwd: PROJECT.path,
      sessionId: SESSION_A,
      includePartialMessages: true,
      model: 'claude-opus-5-5',
      permissionMode: 'acceptEdits',
    });
    expect(q?.options).not.toHaveProperty('settingSources');
    expect(q?.options).not.toHaveProperty('resume');

    expect(session(store, SESSION_A)).toMatchObject({
      origin: 'board',
      projectId: PROJECT.id,
      cwd: PROJECT.path,
      status: { kind: 'working' },
      title: 'Add a cart badge with the item count',
      model: 'claude-opus-5-5',
      permissionMode: 'acceptEdits',
    });
    expect(runner.isLive(SESSION_A)).toBe(true);

    await settle(transcripts);
    expect(q?.prompts).toHaveLength(1);
    expect(q?.prompts[0]?.message).toEqual({
      role: 'user',
      content: 'Add a cart badge\nwith the item count',
    });
    expect(textOf(transcripts, SESSION_A)).toEqual(['user:Add a cart badge\nwith the item count']);

    q?.emit({
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5-5-20261001',
      permissionMode: 'acceptEdits',
      session_id: SESSION_A,
      uuid: 'init-1',
    });
    q?.emit(state('running'));
    q?.emit(assistant('a1', [{ type: 'text', text: 'Adding the badge.' }]));
    q?.emit(result({ result: 'Added the badge.' }));
    q?.emit(state('idle'));
    await settle(transcripts);

    expect(session(store, SESSION_A)).toMatchObject({
      model: 'claude-sonnet-5-5',
      status: { kind: 'idle' },
      lastAssistantText: 'Added the badge.',
      tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
    });
    expect(textOf(transcripts, SESSION_A)).toEqual([
      'user:Add a cart badge\nwith the item count',
      'assistant:Adding the badge.',
    ]);
  });

  it('refuses an unknown project without calling the SDK', async () => {
    const { runner } = setup();
    expect(await runner.startSession({ projectId: 'nope', prompt: 'hi' })).toEqual({
      ok: false,
      error: UNKNOWN_PROJECT,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('tracks tool calls and permission waits from the message stream', async () => {
    const { store, transcripts, runner } = setup();
    await runner.startSession({ projectId: PROJECT.id, prompt: 'Run the tests' });
    const [q] = queries;

    q?.emit(
      assistant('a1', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } },
      ]),
    );
    await settle(transcripts);
    expect(session(store, SESSION_A).status).toEqual({
      kind: 'tool',
      tool: 'Bash',
      toolUseId: 'toolu_1',
    });
    expect(session(store, SESSION_A).currentTool).toMatchObject({
      id: 'toolu_1',
      family: 'bash',
      summary: 'pnpm test',
      status: 'running',
    });

    q?.emit(state('requires_action'));
    await settle();
    expect(session(store, SESSION_A).status).toEqual({
      kind: 'waiting_permission',
      approvalId: null,
    });

    q?.emit({
      type: 'user',
      uuid: 'u2',
      session_id: SESSION_A,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
      },
    });
    q?.emit(state('running'));
    await settle(transcripts);
    expect(session(store, SESSION_A).status.kind).toBe('working');
    expect(session(store, SESSION_A).currentTool).toBeNull();
    expect(transcripts.messages(SESSION_A).map((m) => m.kind)).toEqual([
      'user',
      'tool_use',
      'tool_result',
    ]);
  });

  it('skips subagent traffic and malformed messages', async () => {
    const { store, transcripts, runner } = setup();
    await runner.startSession({ projectId: PROJECT.id, prompt: 'Explore' });
    const [q] = queries;

    q?.emit(null);
    q?.emit({ type: 'assistant', message: 'not an object' });
    q?.emit({ ...assistant('sub', [{ type: 'text', text: 'inner' }]), parent_tool_use_id: 'tu_9' });
    q?.emit({ type: 'system', subtype: 'session_state_changed', state: 'exploding' });
    q?.emit(assistant('a1', [{ type: 'text', text: 'Outer reply.' }]));
    await settle(transcripts);

    expect(textOf(transcripts, SESSION_A)).toEqual(['user:Explore', 'assistant:Outer reply.']);
    expect(session(store, SESSION_A).status.kind).toBe('working');
    expect(runner.isLive(SESSION_A)).toBe(true);
  });

  it('marks the session as failed when the SDK throws', async () => {
    const { store, runner } = setup();
    await runner.startSession({ projectId: PROJECT.id, prompt: 'Go' });
    queries[0]?.fail(new Error('Claude Code exited with code 1'));
    await settle();

    expect(runner.isLive(SESSION_A)).toBe(false);
    expect(session(store, SESSION_A).status).toEqual({
      kind: 'error',
      message: 'Claude Code exited with code 1',
    });
  });

  it('shows a failed turn as an error until the next send', async () => {
    const { store, runner } = setup();
    await runner.startSession({ projectId: PROJECT.id, prompt: 'Go' });
    const [q] = queries;
    q?.emit(result({ subtype: 'error_max_turns', is_error: true, errors: ['Reached max turns'] }));
    q?.emit(state('idle'));
    await settle();
    expect(session(store, SESSION_A).status).toEqual({
      kind: 'error',
      message: 'Reached max turns',
    });

    expect(await runner.send(SESSION_A, 'Keep going')).toEqual({ ok: true });
    expect(session(store, SESSION_A).status.kind).toBe('working');
  });
});

describe('SessionRunner multi-turn', () => {
  it('sends follow-up turns into the same query', async () => {
    const { store, transcripts, runner } = setup();
    await runner.startSession({ projectId: PROJECT.id, prompt: 'First question' });
    const [q] = queries;
    q?.emit(assistant('a1', [{ type: 'text', text: 'First answer.' }]));
    q?.emit(result());
    q?.emit(state('idle'));
    await settle(transcripts);
    expect(session(store, SESSION_A).status.kind).toBe('idle');

    expect(await runner.send(SESSION_A, 'Second question')).toEqual({ ok: true });
    expect(session(store, SESSION_A).status.kind).toBe('working');
    q?.emit(assistant('a2', [{ type: 'text', text: 'Second answer.' }]));
    q?.emit(result({ uuid: 'res-2' }));
    await settle(transcripts);

    expect(query).toHaveBeenCalledTimes(1);
    expect(q?.prompts.map((p) => p.message.content)).toEqual(['First question', 'Second question']);
    expect(new Set(q?.prompts.map((p) => p.uuid)).size).toBe(2);
    expect(textOf(transcripts, SESSION_A)).toEqual([
      'user:First question',
      'assistant:First answer.',
      'user:Second question',
      'assistant:Second answer.',
    ]);
    expect(session(store, SESSION_A).tokens.output).toBe(10);
  });

  it('refuses to send to a session it does not run', async () => {
    const { store, runner } = setup();
    expect(await runner.send(SESSION_B, 'hello')).toEqual({ ok: false, error: NOT_RUNNING });
    store.upsertSession({ id: SESSION_B, origin: 'terminal', cwd: PROJECT.path });
    expect(await runner.send(SESSION_B, 'hello')).toEqual({ ok: false, error: NOT_RUNNING });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('SessionRunner partial streaming', () => {
  it('streams the reply into the session draft and clears it when the block lands', async () => {
    const { store, transcripts, runner } = setup();
    await runner.startSession({ projectId: PROJECT.id, prompt: 'Say hello' });
    const [q] = queries;
    const event = (e: unknown) => ({
      type: 'stream_event',
      event: e,
      uuid: 'se',
      session_id: SESSION_A,
      parent_tool_use_id: null,
    });

    q?.emit(event({ type: 'message_start', message: { id: 'msg_1' } }));
    q?.emit(event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    q?.emit(event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }));
    q?.emit(event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }));
    await settle();
    expect(session(store, SESSION_A).draft).toBe('Hello');

    q?.emit(event({ type: 'content_block_delta', delta: { type: 'text_delta', text: ', world' } }));
    // Thinking and subagent deltas never reach the draft.
    q?.emit(event({ type: 'content_block_delta', delta: { type: 'thinking_delta' } }));
    q?.emit({
      ...event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'X' } }),
      parent_tool_use_id: 'tu_1',
    });
    await settle();
    expect(session(store, SESSION_A).draft).toBe('Hello, world');

    q?.emit(assistant('a1', [{ type: 'text', text: 'Hello, world' }], 'msg_1'));
    await settle(transcripts);
    expect(session(store, SESSION_A).draft).toBeNull();
    expect(session(store, SESSION_A).lastAssistantText).toBe('Hello, world');
    expect(textOf(transcripts, SESSION_A)).toEqual(['user:Say hello', 'assistant:Hello, world']);
  });

  it('throttles draft writes to the store', async () => {
    vi.useFakeTimers();
    try {
      const { store, runner } = setup({ draftIntervalMs: 50 });
      await runner.startSession({ projectId: PROJECT.id, prompt: 'Count' });
      const [q] = queries;
      const writes: unknown[] = [];
      store.onPatch((ops) => {
        for (const op of ops) if (op.path.at(-1) === 'draft') writes.push(op);
      });
      for (const text of ['1', '2', '3', '4']) {
        q?.emit({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
          uuid: 'se',
          session_id: SESSION_A,
          parent_tool_use_id: null,
        });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(session(store, SESSION_A).draft ?? null).toBeNull();
      await vi.advanceTimersByTimeAsync(50);
      expect(session(store, SESSION_A).draft).toBe('1234');
      expect(writes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SessionRunner controls', () => {
  it('interrupts the turn and settles to idle on the interrupted result', async () => {
    const { store, runner } = setup();
    await runner.startSession({ projectId: PROJECT.id, prompt: 'Refactor everything' });
    const [q] = queries;
    expect(await runner.interrupt(SESSION_A)).toEqual({ ok: true });
    expect(q?.interrupt).toHaveBeenCalledTimes(1);

    q?.emit(result({ subtype: 'error_during_execution', is_error: true, errors: [] }));
    await settle();
    expect(session(store, SESSION_A).status.kind).toBe('idle');
    expect(runner.isLive(SESSION_A)).toBe(true);

    // The session keeps going after an interrupt.
    expect(await runner.send(SESSION_A, 'Just the cart, then')).toEqual({ ok: true });
    await settle();
    expect(q?.prompts).toHaveLength(2);
  });

  it('switches model and permission mode on the live query', async () => {
    const { store, runner } = setup();
    await runner.startSession({ projectId: PROJECT.id, prompt: 'Plan it' });
    const [q] = queries;

    expect(await runner.setModel(SESSION_A, 'claude-haiku-5-5')).toEqual({ ok: true });
    expect(q?.setModel).toHaveBeenCalledWith('claude-haiku-5-5');
    expect(session(store, SESSION_A).model).toBe('claude-haiku-5-5');

    expect(await runner.setPermissionMode(SESSION_A, 'plan')).toEqual({ ok: true });
    expect(q?.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(session(store, SESSION_A).permissionMode).toBe('plan');
  });

  it('closes the query and leaves the session ended', async () => {
    const { store, runner } = setup();
    await runner.startSession({ projectId: PROJECT.id, prompt: 'Hi' });
    expect(await runner.close(SESSION_A)).toEqual({ ok: true });
    expect(queries[0]?.close).toHaveBeenCalledTimes(1);
    expect(runner.isLive(SESSION_A)).toBe(false);
    expect(session(store, SESSION_A).status.kind).toBe('ended');
    expect(session(store, SESSION_A).endedAt).not.toBeNull();
  });

  it('answers controls for sessions that are not running', async () => {
    const { runner } = setup();
    const fail = { ok: false, error: NOT_RUNNING };
    expect(await runner.interrupt(SESSION_B)).toEqual(fail);
    expect(await runner.setModel(SESSION_B, 'x')).toEqual(fail);
    expect(await runner.setPermissionMode(SESSION_B, 'plan')).toEqual(fail);
    expect(await runner.close(SESSION_B)).toEqual(fail);
  });
});

describe('SessionRunner resume', () => {
  it('resumes an ended session in place and waits for a prompt', async () => {
    const { store, transcripts, runner } = setup();
    store.upsertSession({
      id: SESSION_B,
      origin: 'terminal',
      projectId: PROJECT.id,
      cwd: PROJECT.path,
      status: { kind: 'ended' },
      title: 'Fix the checkout',
      model: 'claude-sonnet-5-5',
      endedAt: 1_700_000_100_000,
    });

    expect(await runner.resumeSession(SESSION_B)).toEqual({ ok: true, sessionId: SESSION_B });
    const [q] = queries;
    expect(q?.options).toMatchObject({
      cwd: PROJECT.path,
      resume: SESSION_B,
      includePartialMessages: true,
      model: 'claude-sonnet-5-5',
    });
    expect(q?.options).not.toHaveProperty('sessionId');
    expect(q?.options).not.toHaveProperty('forkSession');
    expect(session(store, SESSION_B)).toMatchObject({
      origin: 'board',
      status: { kind: 'idle' },
      title: 'Fix the checkout',
      endedAt: null,
    });
    await settle();
    expect(q?.prompts).toHaveLength(0);

    // A second resume of a live session is a no-op.
    expect(await runner.resumeSession(SESSION_B)).toEqual({ ok: true, sessionId: SESSION_B });
    expect(query).toHaveBeenCalledTimes(1);

    await runner.send(SESSION_B, 'Where were we?');
    await settle(transcripts);
    expect(q?.prompts.map((p) => p.message.content)).toEqual(['Where were we?']);
    expect(textOf(transcripts, SESSION_B)).toEqual(['user:Where were we?']);
  });

  it('forks a live terminal session instead of resuming it in place', async () => {
    const { store, runner } = setup();
    store.upsertSession({
      id: SESSION_B,
      origin: 'terminal',
      projectId: PROJECT.id,
      cwd: PROJECT.path,
      status: { kind: 'working' },
      title: 'Fix the checkout',
    });
    expect(await runner.resumeSession(SESSION_B)).toEqual({ ok: false, error: SESSION_LIVE });
    expect(query).not.toHaveBeenCalled();

    const forked = await runner.resumeSession(SESSION_B, { fork: true });
    expect(forked).toEqual({ ok: true, sessionId: SESSION_A });
    expect(queries[0]?.options).toMatchObject({
      resume: SESSION_B,
      forkSession: true,
      sessionId: SESSION_A,
      cwd: PROJECT.path,
    });
    // Its own "Claude N", never the parent's title; it remembers where it branched off.
    expect(session(store, SESSION_A)).toMatchObject({
      origin: 'board',
      projectId: PROJECT.id,
      title: null,
      customTitle: null,
      ordinal: 2,
      forkedFrom: { sessionId: SESSION_B },
    });
    expect(session(store, SESSION_B).status.kind).toBe('working');
  });

  it('numbers a fork past every session of the project, ended ones included', async () => {
    const { store, runner } = setup();
    store.upsertSession({
      id: SESSION_B,
      origin: 'terminal',
      projectId: PROJECT.id,
      cwd: PROJECT.path,
      status: { kind: 'idle' },
      customTitle: 'retry-backoff',
    });
    const other = '00000000-0000-4000-8000-00000000aaaa';
    store.upsertSession({ id: other, projectId: PROJECT.id, status: { kind: 'idle' } });
    store.setSessionStatus(other, { kind: 'ended' });
    expect(session(store, other).ordinal).toBe(1);

    await runner.resumeSession(SESSION_B, { fork: true });
    // "Claude" is still listed (ended), and the parent's own name isn't copied.
    expect(session(store, SESSION_A)).toMatchObject({ ordinal: 2, customTitle: null });
  });

  it('leaves running sessions interrupted when the server stops, not ended', async () => {
    const { store, runner } = setup();
    await runner.startSession({ projectId: PROJECT.id, prompt: 'Fix the checkout' });
    await runner.resumeSession(SESSION_B, { projectId: PROJECT.id });
    const [busy, idle] = queries;
    busy?.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
    idle?.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    await settle();
    expect(runner.liveCount).toBe(2);

    await runner.suspendAll();
    expect(busy?.close).toHaveBeenCalled();
    expect(runner.liveCount).toBe(0);
    expect(session(store, SESSION_A)).toMatchObject({
      status: { kind: 'interrupted', turnRunning: true },
      endedAt: null,
    });
    expect(session(store, SESSION_B).status).toEqual({ kind: 'interrupted', turnRunning: false });
  });

  it('resumes a past session from the history browser by project', async () => {
    const { store, runner } = setup();
    expect(await runner.resumeSession(SESSION_B)).toEqual({ ok: false, error: UNKNOWN_SESSION });

    expect(await runner.resumeSession(SESSION_B, { projectId: PROJECT.id })).toEqual({
      ok: true,
      sessionId: SESSION_B,
    });
    expect(queries[0]?.options).toMatchObject({ resume: SESSION_B, cwd: PROJECT.path });
    expect(session(store, SESSION_B)).toMatchObject({ origin: 'board', projectId: PROJECT.id });
  });

  it('resumes a closed board session when the user sends to it', async () => {
    const { store, runner } = setup();
    await runner.startSession({ projectId: PROJECT.id, prompt: 'One' });
    await runner.close(SESSION_A);
    expect(session(store, SESSION_A).status.kind).toBe('ended');

    expect(await runner.send(SESSION_A, 'Two')).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(queries[1]?.options).toMatchObject({ resume: SESSION_A });
    await settle();
    expect(queries[1]?.prompts.map((p) => p.message.content)).toEqual(['Two']);
    expect(session(store, SESSION_A).status.kind).toBe('working');
  });
});

describe('SessionRunner actions', () => {
  it('exposes the controls as UI action handlers', async () => {
    const { store, runner } = setup();
    const actions = runner.actions();
    expect(
      await actions['session.create']({
        kind: 'session.create',
        projectId: PROJECT.id,
        prompt: 'Hi',
      }),
    ).toEqual({ ok: true, sessionId: SESSION_A });
    expect(
      await actions['session.setModel']({
        kind: 'session.setModel',
        sessionId: SESSION_A,
        model: 'claude-opus-5-5',
      }),
    ).toEqual({ ok: true });
    expect(
      await actions['session.interrupt']({ kind: 'session.interrupt', sessionId: SESSION_A }),
    ).toEqual({ ok: true });
    expect(await actions['session.close']({ kind: 'session.close', sessionId: SESSION_A })).toEqual(
      { ok: true },
    );
    expect(session(store, SESSION_A).status.kind).toBe('ended');
    expect(
      await actions['session.resume']({ kind: 'session.resume', sessionId: 'missing' }),
    ).toEqual({ ok: false, error: UNKNOWN_SESSION });
  });
});

describe('SessionRunner approvals', () => {
  type Ask = NonNullable<Options['canUseTool']>;
  const ALWAYS: PermissionUpdate[] = [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'pnpm test:*' }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ];

  /** Starts a session and returns its `canUseTool`, plus a way to ask it. */
  async function started(options: { approvalTimeoutMs?: number } = {}) {
    const ctx = setup(options);
    await ctx.runner.startSession({ projectId: PROJECT.id, prompt: 'Run the tests' });
    const q = queries.at(-1);
    const canUseTool = q?.options.canUseTool as Ask;
    expect(canUseTool).toBeTypeOf('function');
    const ask = (
      tool: string,
      input: Record<string, unknown>,
      extra: Partial<Parameters<Ask>[2]> = {},
    ) => {
      const controller = new AbortController();
      const promise = canUseTool(tool, input, {
        signal: controller.signal,
        toolUseID: `toolu_${tool}`,
        requestId: `req_${tool}`,
        ...extra,
      });
      return { promise, controller };
    };
    const pending = () =>
      Object.values(ctx.store.state.approvals).filter((a) => a.state === 'pending');
    return { ...ctx, q, ask, pending };
  }

  it('turns a permission request into a pending approval and allows it once', async () => {
    const { store, runner, messages, events, q, ask, pending } = await started();
    q?.emit(
      assistant('a1', [
        { type: 'tool_use', id: 'toolu_Bash', name: 'Bash', input: { command: 'pnpm test' } },
      ]),
    );
    await settle();
    const { promise } = ask('Bash', { command: 'pnpm test' }, { suggestions: [...ALWAYS] });

    const [approval] = pending();
    expect(approval).toMatchObject({
      sessionId: SESSION_A,
      source: 'sdk',
      tool: 'Bash',
      input: { command: 'pnpm test' },
      toolUseId: 'toolu_Bash',
      suggestions: ALWAYS,
      blockedPath: null,
      expiresAt: null,
      state: 'pending',
    });
    if (!approval) throw new Error('no approval');
    expect(session(store, SESSION_A).status).toEqual({
      kind: 'waiting_permission',
      approvalId: approval.id,
    });
    // The SDK's own requires_action notice doesn't drop the approval id.
    q?.emit(state('requires_action'));
    await settle();
    expect(session(store, SESSION_A).status).toMatchObject({ approvalId: approval.id });
    expect(messages).toEqual([
      expect.objectContaining({ type: 'approval.new', payload: { approval } }),
    ]);

    expect(runner.decideApproval({ approvalId: approval.id, decision: 'allow' })).toEqual({
      ok: true,
    });
    expect(await promise).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'pnpm test' },
      toolUseID: 'toolu_Bash',
    });
    expect(store.state.approvals[approval.id]).toMatchObject({ state: 'allowed', reason: null });
    expect(session(store, SESSION_A).status).toEqual({
      kind: 'tool',
      tool: 'Bash',
      toolUseId: 'toolu_Bash',
    });
    expect(messages[1]).toMatchObject({
      type: 'approval.resolved',
      payload: { approvalId: approval.id, state: 'allowed', reason: null },
    });
    expect(events.map((e) => [e.kind, e.sessionId, e.projectId, e.summary])).toEqual([
      ['permission.request', SESSION_A, PROJECT.id, 'Bash needs approval'],
      ['permission.decision', SESSION_A, PROJECT.id, 'Bash allowed'],
    ]);

    // Deciding twice is refused; the SDK already has its answer.
    expect(runner.decideApproval({ approvalId: approval.id, decision: 'deny' })).toEqual({
      ok: false,
      error: UNKNOWN_APPROVAL,
    });
  });

  it('returns the suggestions as updatedPermissions on always allow', async () => {
    const { runner, ask, pending } = await started();
    const { promise } = ask(
      'Bash',
      { command: 'pnpm test' },
      { suggestions: [...ALWAYS], blockedPath: '/home/dev/shared' },
    );
    const [approval] = pending();
    expect(approval?.blockedPath).toBe('/home/dev/shared');
    runner.decideApproval({ approvalId: approval?.id ?? '', decision: 'allowAlways' });
    expect(await promise).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'pnpm test' },
      updatedPermissions: ALWAYS,
      toolUseID: 'toolu_Bash',
    });
  });

  it('never offers always allow when the SDK suppresses it', async () => {
    const { runner, ask, pending } = await started();
    const { promise } = ask(
      'Bash',
      { command: 'rm -rf dist' },
      { suggestions: [...ALWAYS], suppressAlwaysAllowRule: true },
    );
    const [approval] = pending();
    expect(approval?.suggestions).toEqual([]);
    runner.decideApproval({ approvalId: approval?.id ?? '', decision: 'allowAlways' });
    expect(await promise).not.toHaveProperty('updatedPermissions');
  });

  it('denies with the user message, or a default one', async () => {
    const { store, runner, messages, ask, pending } = await started();
    const first = ask('Bash', { command: 'git push --force' });
    const firstId = pending()[0]?.id ?? '';
    runner.decideApproval({
      approvalId: firstId,
      decision: 'deny',
      reason: 'Push to a branch instead',
    });
    expect(await first.promise).toEqual({
      behavior: 'deny',
      message: 'Push to a branch instead',
      toolUseID: 'toolu_Bash',
    });
    expect(store.state.approvals[firstId]).toMatchObject({
      state: 'denied',
      reason: 'Push to a branch instead',
    });
    expect(messages.at(-1)).toMatchObject({
      type: 'approval.resolved',
      payload: { approvalId: firstId, state: 'denied', reason: 'Push to a branch instead' },
    });
    expect(session(store, SESSION_A).status).toEqual({ kind: 'working' });

    const second = ask('Write', { file_path: '/home/dev/acme-shop/.env' });
    runner.decideApproval({ approvalId: pending()[0]?.id ?? '', decision: 'deny' });
    expect(await second.promise).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('denied'),
    });
  });

  it('expires the approval when the SDK aborts the request', async () => {
    const { store, runner, messages, ask, pending } = await started();
    const { promise, controller } = ask('Bash', { command: 'pnpm build' });
    const id = pending()[0]?.id ?? '';
    controller.abort();
    expect(await promise).toMatchObject({ behavior: 'deny' });
    expect(store.state.approvals[id]).toMatchObject({ state: 'expired', reason: 'Cancelled' });
    expect(messages.at(-1)).toMatchObject({
      type: 'approval.resolved',
      payload: { approvalId: id, state: 'expired' },
    });
    expect(session(store, SESSION_A).status).toEqual({ kind: 'working' });
    expect(runner.decideApproval({ approvalId: id, decision: 'allow' })).toEqual({
      ok: false,
      error: UNKNOWN_APPROVAL,
    });

    // Already aborted: answered at once, nothing is shown.
    const late = new AbortController();
    late.abort();
    const canUseTool = queries[0]?.options.canUseTool as Ask;
    expect(
      await canUseTool(
        'Bash',
        {},
        { signal: late.signal, toolUseID: 'toolu_late', requestId: 'req_late' },
      ),
    ).toMatchObject({ behavior: 'deny' });
    expect(pending()).toEqual([]);
  });

  it('expires pending approvals when the session closes', async () => {
    const { store, runner, ask, pending } = await started();
    const { promise } = ask('Bash', { command: 'pnpm test' });
    const id = pending()[0]?.id ?? '';
    await runner.close(SESSION_A);
    expect(await promise).toMatchObject({ behavior: 'deny' });
    expect(store.state.approvals[id]).toMatchObject({ state: 'expired' });
    expect(session(store, SESSION_A).status.kind).toBe('ended');
  });

  it('waits indefinitely by default and expires after a configured timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const plain = await started();
      plain.ask('Bash', { command: 'pnpm test' });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
      expect(plain.pending()).toHaveLength(1);

      const timed = await started({ approvalTimeoutMs: 30_000 });
      const { promise } = timed.ask('Bash', { command: 'pnpm test' });
      const approval = timed.pending()[0];
      expect(approval?.expiresAt).toBe((approval?.createdAt ?? 0) + 30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await promise).toMatchObject({ behavior: 'deny', message: 'Approval timed out.' });
      expect(timed.store.state.approvals[approval?.id ?? '']).toMatchObject({
        state: 'expired',
        reason: 'Timed out',
      });

      // Resolved approvals linger for the UI, then leave the store.
      await vi.advanceTimersByTimeAsync(RESOLVED_APPROVAL_TTL_MS);
      expect(timed.store.state.approvals).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps concurrent approvals apart and waits on the oldest', async () => {
    const { store, runner, ask, pending } = await started();
    const test = ask('Bash', { command: 'pnpm test' });
    const write = ask('Write', { file_path: '/home/dev/acme-shop/src/cart.ts' });
    const [first, second] = pending();
    expect(first?.tool).toBe('Bash');
    expect(second?.tool).toBe('Write');
    expect(first?.id).not.toBe(second?.id);
    expect(session(store, SESSION_A).status).toEqual({
      kind: 'waiting_permission',
      approvalId: first?.id,
    });

    runner.decideApproval({ approvalId: second?.id ?? '', decision: 'deny', reason: 'Not yet' });
    expect(await write.promise).toMatchObject({ behavior: 'deny', message: 'Not yet' });
    expect(session(store, SESSION_A).status).toEqual({
      kind: 'waiting_permission',
      approvalId: first?.id,
    });

    runner.decideApproval({ approvalId: first?.id ?? '', decision: 'allow' });
    expect(await test.promise).toMatchObject({
      behavior: 'allow',
      updatedInput: { command: 'pnpm test' },
    });
    expect(session(store, SESSION_A).status).toEqual({
      kind: 'tool',
      tool: 'Bash',
      toolUseId: 'toolu_Bash',
    });
  });
});

describe('MessageQueue', () => {
  it('delivers pushed items in order to a waiting reader and ends cleanly', async () => {
    const queue = new MessageQueue<number>();
    const seen: number[] = [];
    const reading = (async () => {
      for await (const item of queue) seen.push(item);
    })();
    queue.push(1);
    await Promise.resolve();
    queue.push(2);
    queue.push(3);
    queue.end();
    queue.push(4);
    await reading;
    expect(seen).toEqual([1, 2, 3]);
  });
});
