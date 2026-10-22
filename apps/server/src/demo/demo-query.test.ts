import { type ChatMessage, decodeChatMessage, type Project } from '@c-board/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionRunner } from '../claude/runner.js';
import { BoardStore } from '../store.js';
import { createDemoQuery } from './demo-query.js';
import { DemoTranscripts } from './transcripts.js';

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
const logger = { warn: () => {}, debug: () => {} };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup(timing: { wordMs?: number } = {}) {
  const store = new BoardStore();
  store.upsertProject(PROJECT);
  const transcripts = new DemoTranscripts();
  let n = 0;
  const runner = new SessionRunner({
    store,
    transcripts,
    logger,
    draftIntervalMs: 0,
    newId: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
    query: createDemoQuery({
      thinkMs: 1,
      toolMs: 1,
      wordMs: timing.wordMs ?? 0,
      onFork: (from, to) => transcripts.copy(from, to),
    }),
  });
  cleanups.push(() => runner.closeAll());
  const messages = (sessionId: string): ChatMessage[] =>
    (transcripts.read(`transcript:${sessionId}`)?.chunks ?? [])
      .map(({ chunk }) => decodeChatMessage(chunk))
      .filter((m): m is ChatMessage => m !== null);
  return { store, runner, messages };
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('demo query', () => {
  it('answers a prompt with a tool call and a streamed reply, then goes idle', async () => {
    const { store, runner, messages } = setup({ wordMs: 2 });
    const started = await runner.startSession({ projectId: PROJECT.id, prompt: 'Tidy the cart' });
    if (!started.ok) throw new Error(started.error);
    const id = started.sessionId;

    // Partial text streams into the draft before the message lands.
    await until(() => (store.state.sessions[id]?.draft ?? '').length > 0);
    expect(store.state.sessions[id]?.model).toBe('claude-opus-5-5');
    await until(() => store.state.sessions[id]?.status.kind === 'idle');

    const session = store.state.sessions[id];
    expect(session?.origin).toBe('board');
    expect(session?.draft ?? null).toBeNull();
    expect(session?.lastAssistantText).toMatch(/\S/);
    expect(messages(id).map((m) => m.kind)).toEqual([
      'user',
      'tool_use',
      'tool_result',
      'assistant',
    ]);

    // A second turn has no tool call.
    expect(await runner.send(id, 'Go ahead')).toEqual({ ok: true });
    await until(() => messages(id).length === 6);
    expect(
      messages(id)
        .slice(4)
        .map((m) => m.kind),
    ).toEqual(['user', 'assistant']);
  });

  it('stops a turn on interrupt and keeps the text written so far', async () => {
    const { store, runner, messages } = setup({ wordMs: 20 });
    const started = await runner.startSession({ projectId: PROJECT.id, prompt: 'Explain it' });
    if (!started.ok) throw new Error(started.error);
    const id = started.sessionId;
    await until(() => (store.state.sessions[id]?.draft ?? '').length > 0);

    expect(await runner.interrupt(id)).toEqual({ ok: true });
    await until(() => store.state.sessions[id]?.status.kind === 'idle');
    const last = messages(id).at(-1);
    expect(last?.kind).toBe('assistant');
    expect(store.state.sessions[id]?.draft ?? null).toBeNull();
    // Still live: the next prompt starts a new turn.
    expect(runner.isLive(id)).toBe(true);
  });

  it('switches the model by alias', async () => {
    const { store, runner } = setup();
    const started = await runner.startSession({
      projectId: PROJECT.id,
      prompt: 'Hi',
      model: 'sonnet',
    });
    if (!started.ok) throw new Error(started.error);
    await until(() => store.state.sessions[started.sessionId]?.model === 'claude-sonnet-5-5');
    expect(await runner.setModel(started.sessionId, 'haiku')).toEqual({ ok: true });
    expect(store.state.sessions[started.sessionId]?.model).toBe('haiku');
  });

  it('starts a fork with its parent conversation', async () => {
    const { store, runner, messages } = setup();
    const started = await runner.startSession({ projectId: PROJECT.id, prompt: 'First' });
    if (!started.ok) throw new Error(started.error);
    const parent = started.sessionId;
    await until(() => store.state.sessions[parent]?.status.kind === 'idle');

    const forked = await runner.resumeSession(parent, { fork: true });
    if (!forked.ok) throw new Error(forked.error);
    expect(forked.sessionId).not.toBe(parent);
    expect(messages(forked.sessionId).map((m) => ('text' in m ? m.text : m.kind))).toEqual(
      messages(parent).map((m) => ('text' in m ? m.text : m.kind)),
    );
  });
});
