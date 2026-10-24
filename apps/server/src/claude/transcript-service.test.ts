import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ChatMessage,
  decodeChatMessage,
  startBackground,
  transcriptStreamId,
} from '@yardmaster/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardStore } from '../store.js';
import { FIXTURE_CWD, FIXTURE_SESSION_ID } from './fixtures.test-helpers.js';
import {
  encodeProjectDir,
  type FileWatcher,
  type HistoryLoader,
  TranscriptService,
} from './transcript-service.js';

const FIXTURE = new URL('../../fixtures/transcripts/session.jsonl', import.meta.url);
const logger = { warn: () => {}, debug: () => {} };
const STREAM = transcriptStreamId(FIXTURE_SESSION_ID);

let dir: string;
let path: string;
let fixture: string;
const services: TranscriptService[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yardmaster-transcripts-'));
  path = join(dir, `${FIXTURE_SESSION_ID}.jsonl`);
  fixture = await readFile(FIXTURE, 'utf8');
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await rm(dir, { recursive: true, force: true });
});

/** A watcher the test fires by hand. */
function manualWatcher() {
  const watched = new Map<string, () => void>();
  const watchFile: FileWatcher = (file, onChange) => {
    watched.set(file, onChange);
    return async () => {
      watched.delete(file);
    };
  };
  return { watchFile, watched, fire: (file = path) => watched.get(file)?.() };
}

function setup(
  options: { loadHistory?: HistoryLoader | null; watchFile?: FileWatcher; configDir?: string } = {},
) {
  const store = new BoardStore();
  const service = new TranscriptService({
    store,
    logger,
    loadHistory: options.loadHistory ?? null,
    watchFile: options.watchFile ?? manualWatcher().watchFile,
    claudeConfigDir: options.configDir ?? join(dir, 'claude'),
  });
  services.push(service);
  return { store, service };
}

async function settled(service: TranscriptService): Promise<void> {
  // Patches reach the service on a microtask, then its queue runs.
  await new Promise((resolve) => setImmediate(resolve));
  await service.idle();
}

const kinds = (messages: ChatMessage[]) => messages.map((m) => m.kind);
const FIXTURE_KINDS = [
  'user',
  'user',
  'thinking',
  'assistant',
  'tool_use',
  'tool_result',
  'tool_use',
  'tool_result',
];

describe('TranscriptService', () => {
  it('loads history from the JSONL file and computes tokens and context size', async () => {
    await writeFile(path, fixture);
    const { store, service } = setup();
    store.upsertSession({ id: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, transcriptPath: path });
    await settled(service);

    expect(kinds(service.messages(FIXTURE_SESSION_ID))).toEqual(FIXTURE_KINDS);
    const session = store.state.sessions[FIXTURE_SESSION_ID];
    expect(session?.tokens).toEqual({
      input: 150,
      output: 85,
      cacheRead: 18000,
      cacheCreation: 2500,
    });
    expect(session?.contextTokens).toBe(30 + 10000 + 500 + 25);
    expect(session?.model).toBe('claude-sonnet-5-5');
  });

  it('takes the newest /rename line as the custom title', async () => {
    const rename = (customTitle: unknown) =>
      JSON.stringify({ type: 'custom-title', customTitle, sessionId: FIXTURE_SESSION_ID });
    await writeFile(path, `${fixture.trimEnd()}\n${rename('Cart  totals')}\n${rename(42)}\n`);
    const watcher = manualWatcher();
    const { store, service } = setup({ watchFile: watcher.watchFile });
    store.upsertSession({ id: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, transcriptPath: path });
    await settled(service);
    expect(store.state.sessions[FIXTURE_SESSION_ID]?.customTitle).toBe('Cart totals');

    await appendFile(path, `${rename('Checkout')}\n`);
    watcher.fire();
    await settled(service);
    expect(store.state.sessions[FIXTURE_SESSION_ID]?.customTitle).toBe('Checkout');
    expect(kinds(service.messages(FIXTURE_SESSION_ID))).toEqual(FIXTURE_KINDS);
  });

  it('tails increments: completes the truncated line and appends new messages to the stream', async () => {
    await writeFile(path, fixture);
    const watcher = manualWatcher();
    const { store, service } = setup({ watchFile: watcher.watchFile });
    const received: [string, number, ChatMessage | null][] = [];
    service.onData((streamId, seq, chunk) =>
      received.push([streamId, seq, decodeChatMessage(chunk)]),
    );
    store.upsertSession({ id: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, transcriptPath: path });
    await settled(service);
    expect(watcher.watched.has(path)).toBe(true);
    expect(received).toHaveLength(8);

    await appendFile(
      path,
      'ed."}],"usage":{"input_tokens":5,"cache_read_input_tokens":11000,"output_tokens":12}}}\n' +
        `${JSON.stringify({
          type: 'user',
          uuid: '0b1c2d3e-0000-4000-8000-00000000000d',
          message: { role: 'user', content: 'Fix it please' },
        })}\n`,
    );
    watcher.fire();
    await settled(service);

    expect(received.slice(8).map(([id, seq, m]) => [id, seq, m?.kind])).toEqual([
      [STREAM, 8, 'assistant'],
      [STREAM, 9, 'user'],
    ]);
    expect(received[8]?.[2]).toMatchObject({ text: 'One test failed.' });
    expect(service.read(STREAM, 9)?.chunks.map((c) => c.seq)).toEqual([9]);
    expect(service.nextSeq(STREAM)).toBe(10);
    const session = store.state.sessions[FIXTURE_SESSION_ID];
    expect(session?.tokens.output).toBe(85 + 12);
    expect(session?.contextTokens).toBe(5 + 11000 + 12);

    // A change event with nothing new reads nothing.
    watcher.fire();
    await settled(service);
    expect(received).toHaveLength(10);
  });

  it('prefers SDK history and skips lines it already returned', async () => {
    const all = fixture.split('\n');
    await writeFile(path, `${all.slice(0, 8).join('\n')}\n`);
    const loadHistory = vi.fn<HistoryLoader>(async (sessionId) => {
      // A line lands while the SDK reads; it returns it too.
      await appendFile(path, `${all[11]}\n`);
      return [...all.slice(0, 8), all[11] as string]
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.type === 'user' || line.type === 'assistant')
        .map((line) => ({
          type: line.type,
          uuid: line.uuid,
          session_id: sessionId,
          message: line.message,
          parent_tool_use_id: null,
        }));
    });
    const watcher = manualWatcher();
    const { store, service } = setup({ loadHistory, watchFile: watcher.watchFile });
    store.upsertSession({ id: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, transcriptPath: path });
    await settled(service);

    expect(loadHistory).toHaveBeenCalledWith(FIXTURE_SESSION_ID, FIXTURE_CWD);
    const messages = service.messages(FIXTURE_SESSION_ID);
    expect(kinds(messages)).toEqual([...FIXTURE_KINDS.slice(0, 6), 'tool_use']);

    await appendFile(path, `${all[12]}\n`);
    watcher.fire();
    await settled(service);
    expect(kinds(service.messages(FIXTURE_SESSION_ID))).toEqual(FIXTURE_KINDS);
  });

  it('starts a new fork from the conversation of its parent', async () => {
    const fork = '00000000-0000-4000-8000-00000000f0f0';
    const loadHistory = vi.fn<HistoryLoader>(async (sessionId) =>
      sessionId === FIXTURE_SESSION_ID
        ? [
            {
              type: 'user',
              uuid: '00000000-0000-4000-8000-0000000000a1',
              timestamp: '2026-01-15T12:00:00.000Z',
              message: { role: 'user', content: 'Fix the checkout' },
            },
          ]
        : [],
    );
    const { store, service } = setup({ loadHistory });
    service.claim(fork);
    store.upsertSession({
      id: fork,
      origin: 'board',
      cwd: FIXTURE_CWD,
      forkedFrom: { sessionId: FIXTURE_SESSION_ID, at: Date.UTC(2026, 0, 15, 13) },
    });
    await settled(service);
    expect(loadHistory).toHaveBeenCalledWith(FIXTURE_SESSION_ID, FIXTURE_CWD);
    expect(kinds(service.messages(fork))).toEqual(['user']);
  });

  it('falls back to the JSONL file when the SDK fails or finds nothing', async () => {
    await writeFile(path, fixture);
    for (const loadHistory of [
      vi.fn<HistoryLoader>(async () => {
        throw new Error('no such session');
      }),
      vi.fn<HistoryLoader>(async () => []),
    ]) {
      const { store, service } = setup({ loadHistory });
      store.upsertSession({ id: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, transcriptPath: path });
      await settled(service);
      expect(loadHistory).toHaveBeenCalled();
      expect(kinds(service.messages(FIXTURE_SESSION_ID))).toEqual(FIXTURE_KINDS);
    }
  });

  it('derives the transcript path from the cwd, then follows the path a hook reports', async () => {
    const configDir = join(dir, 'claude');
    const derived = join(configDir, 'projects', encodeProjectDir(FIXTURE_CWD));
    expect(encodeProjectDir(FIXTURE_CWD)).toBe('-home-dev-acme-shop');
    await mkdir(derived, { recursive: true });
    const lines = fixture.split('\n');
    await writeFile(
      join(derived, `${FIXTURE_SESSION_ID}.jsonl`),
      `${lines.slice(0, 3).join('\n')}\n`,
    );
    const watcher = manualWatcher();
    const { store, service } = setup({ configDir, watchFile: watcher.watchFile });
    store.upsertSession({ id: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD });
    await settled(service);
    expect(kinds(service.messages(FIXTURE_SESSION_ID))).toEqual(['user']);

    await writeFile(path, fixture);
    store.updateSession(FIXTURE_SESSION_ID, { transcriptPath: path });
    await settled(service);
    expect(kinds(service.messages(FIXTURE_SESSION_ID))).toEqual(FIXTURE_KINDS);
    expect([...watcher.watched.keys()]).toEqual([path]);
  });

  it('does a final read and stops watching when the session ends or is removed', async () => {
    await writeFile(path, fixture);
    const watcher = manualWatcher();
    const { store, service } = setup({ watchFile: watcher.watchFile });
    store.upsertSession({ id: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, transcriptPath: path });
    await settled(service);

    await appendFile(path, 'ed."}]}}\n');
    store.setSessionStatus(FIXTURE_SESSION_ID, { kind: 'ended' });
    await settled(service);
    expect(watcher.watched.size).toBe(0);
    expect(service.messages(FIXTURE_SESSION_ID)).toHaveLength(9);

    store.removeSession(FIXTURE_SESSION_ID);
    await settled(service);
    expect(service.messages(FIXTURE_SESSION_ID)).toEqual([]);
    expect(service.read(STREAM)).toBeUndefined();
  });

  it('tracks sessions that exist before it starts and handles a missing transcript', async () => {
    const store = new BoardStore();
    store.upsertSession({ id: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, transcriptPath: path });
    const service = new TranscriptService({
      store,
      logger,
      loadHistory: null,
      watchFile: manualWatcher().watchFile,
    });
    services.push(service);
    await settled(service);
    expect(service.messages(FIXTURE_SESSION_ID)).toEqual([]);
    expect(store.state.sessions[FIXTURE_SESSION_ID]?.contextTokens).toBeNull();
  });

  it('takes live messages from the runner for a claimed session, then tails after release', async () => {
    // Complete lines only: the fixture ends mid-line.
    await writeFile(path, fixture.slice(0, fixture.lastIndexOf('\n') + 1));
    const watcher = manualWatcher();
    const history = vi.fn<HistoryLoader>(async () => []);
    const { store, service } = setup({ watchFile: watcher.watchFile, loadHistory: history });
    service.claim(FIXTURE_SESSION_ID);
    store.upsertSession({ id: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, transcriptPath: path });
    // Fed before the store's patch arrives: it queues behind the history load.
    service.feed(FIXTURE_SESSION_ID, [
      { type: 'user', uuid: 'live-1', message: { role: 'user', content: 'Live prompt' } },
    ]);
    await settled(service);

    expect(history).toHaveBeenCalledTimes(1);
    expect(watcher.watched.has(path)).toBe(false);
    expect(service.messages(FIXTURE_SESSION_ID).map((m) => m.kind === 'user' && m.text)).toEqual([
      'Live prompt',
    ]);

    // Duplicates by uuid are dropped, as with history.
    service.feed(FIXTURE_SESSION_ID, [
      { type: 'user', uuid: 'live-1', message: { role: 'user', content: 'Live prompt' } },
    ]);
    await settled(service);
    expect(service.messages(FIXTURE_SESSION_ID)).toHaveLength(1);

    service.release(FIXTURE_SESSION_ID);
    await settled(service);
    expect(watcher.watched.has(path)).toBe(true);
    // The file's existing lines were written by the runner's session: not replayed.
    expect(service.messages(FIXTURE_SESSION_ID)).toHaveLength(1);

    await appendFile(
      path,
      `${JSON.stringify({
        type: 'user',
        uuid: '0b1c2d3e-0000-4000-8000-00000000000e',
        message: { role: 'user', content: 'Typed in a terminal' },
      })}\n`,
    );
    watcher.fire();
    await settled(service);
    expect(service.messages(FIXTURE_SESSION_ID).at(-1)).toMatchObject({
      kind: 'user',
      text: 'Typed in a terminal',
    });
  });

  it('finishes background tasks the transcript reports done', async () => {
    const { store, service } = setup({ loadHistory: async () => [] });
    service.claim(FIXTURE_SESSION_ID);
    store.upsertSession({
      id: FIXTURE_SESSION_ID,
      cwd: FIXTURE_CWD,
      background: startBackground([], { id: 'b1', kind: 'shell', label: 'Build', ts: 1 }),
    });
    await settled(service);
    const updatedAt = store.state.sessions[FIXTURE_SESSION_ID]?.updatedAt;
    service.feed(FIXTURE_SESSION_ID, [
      {
        type: 'user',
        uuid: 'note-1',
        message: {
          role: 'user',
          content:
            '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Build" completed (exit code 0)</summary>\n</task-notification>',
        },
      },
      {
        type: 'user',
        uuid: 'note-2',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<task-notification><task-id>zz</task-id><status>failed</status></task-notification>',
            },
          ],
        },
      },
    ]);
    await settled(service);
    const session = store.state.sessions[FIXTURE_SESSION_ID];
    expect(session?.background).toEqual([
      expect.objectContaining({ id: 'b1', status: 'done', exitCode: 0 }),
    ]);
    expect(session?.background?.[0]?.tail).toContain('completed');
    expect(session?.updatedAt).toBe(updatedAt);
  });

  it('follows a real file with the default chokidar watcher', async () => {
    await writeFile(path, `${fixture.split('\n').slice(0, 3).join('\n')}\n`);
    const store = new BoardStore();
    const service = new TranscriptService({ store, logger, loadHistory: null });
    services.push(service);
    store.upsertSession({ id: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, transcriptPath: path });
    await settled(service);
    expect(service.messages(FIXTURE_SESSION_ID)).toHaveLength(1);

    // Give the watcher a moment to arm before writing.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await appendFile(path, `${fixture.split('\n').slice(3, 6).join('\n')}\n`);
    await vi.waitFor(() => expect(service.messages(FIXTURE_SESSION_ID)).toHaveLength(4), {
      timeout: 5_000,
    });
  });
});
