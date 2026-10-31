import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, ClaudeSession, Project } from '@yardmaster/protocol';
import { transcriptStreamId } from '@yardmaster/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Persistence } from '../persistence.js';
import { BoardStore } from '../store.js';
import {
  ftsQuery,
  messageWindow,
  searchableText,
  snippetRuns,
  TranscriptIndex,
  type TranscriptIndexSettings,
} from './transcript-index.js';
import { encodeProjectDir } from './transcript-service.js';

const CWD = '/home/dev/acme-shop';
const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const T0 = Date.UTC(2026, 0, 15, 12);
const silent = { warn() {}, debug() {} };

const user = (uuid: string, text: string, ts = T0, cwd = CWD) =>
  JSON.stringify({
    type: 'user',
    uuid,
    cwd,
    timestamp: new Date(ts).toISOString(),
    message: { role: 'user', content: text },
  });
const assistant = (uuid: string, text: string, ts = T0) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: new Date(ts).toISOString(),
    message: { id: `msg_${uuid}`, content: [{ type: 'text', text }] },
  });
const tool = (uuid: string, command: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    message: {
      id: `msg_${uuid}`,
      content: [{ type: 'tool_use', id: `tool_${uuid}`, name: 'Bash', input: { command } }],
    },
  });

function project(id: string, path: string): Project {
  return { id, path, name: id, accent: 1, source: 'editor', git: null, createdAt: T0 } as Project;
}

describe('TranscriptIndex', () => {
  let dir: string;
  let db: Persistence;
  let store: BoardStore;
  let settings: TranscriptIndexSettings;
  let floor: number;
  let index: TranscriptIndex;
  let now: number;

  const transcript = (session: string, cwd = CWD) =>
    join(dir, 'projects', encodeProjectDir(cwd), `${session}.jsonl`);
  const write = async (session: string, lines: string[], cwd = CWD) => {
    await mkdir(join(dir, 'projects', encodeProjectDir(cwd)), { recursive: true });
    await writeFile(transcript(session, cwd), `${lines.join('\n')}\n`);
  };
  const search = (q: string, extra: object = {}) =>
    index.search({ q, status: 'all', limit: 40, ...extra });
  const makeIndex = () =>
    new TranscriptIndex({
      db: db.database,
      store,
      logger: silent,
      settings: () => settings,
      floor: () => floor,
      setFloor: (ts) => {
        floor = ts;
      },
      claudeConfigDir: dir,
      now: () => now,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ym-index-'));
    db = new Persistence({ path: ':memory:', pruneIntervalMs: 0 });
    store = new BoardStore();
    settings = { maxBytes: 100 * 1024 * 1024, includeTools: false };
    floor = 0;
    now = T0;
    store.upsertProject(project('acme', CWD));
    index = makeIndex();
  });

  afterEach(async () => {
    index.close();
    await index.idle();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('indexes user and assistant text from every transcript, with a highlighted snippet', async () => {
    await write(SESSION, [user('u1', 'Why is the checkout rounding wrong?')]);
    await write(OTHER, [assistant('a1', 'The refund ledger is fixed.')], '/home/dev/other');
    await index.scan();

    const [hit] = search('rounding').hits;
    expect(hit).toMatchObject({
      sessionId: SESSION,
      messageId: 'u1:0',
      kind: 'user',
      ts: T0,
      projectId: 'acme',
      projectName: 'acme',
      state: 'finished',
      title: 'Why is the checkout rounding wrong?',
    });
    expect(hit?.snippet.filter((run) => run.hit).map((run) => run.text)).toEqual(['rounding']);
    expect(search('ledger').hits).toHaveLength(1);
    expect(search('nothing-like-this').hits).toEqual([]);
  });

  it('skips a malformed transcript line and keeps the rest', async () => {
    await write(SESSION, [
      user('u1', 'first good line'),
      '{"type":"user","uuid":"broken", not json',
      'plain garbage',
      '[1,2,3]',
      '{"type":"assistant","uuid":"a0","message":{"content":"not blocks"}}',
      assistant('a1', 'second good line'),
    ]);
    await index.scan();
    expect(
      search('good')
        .hits.map((hit) => hit.messageId)
        .sort(),
    ).toEqual(['a1:0', 'u1:0']);
    expect(index.status()).toMatchObject({ sessions: 1, messages: 2 });
  });

  it('reads only what is new on the next pass', async () => {
    await write(SESSION, [user('u1', 'alpha words')]);
    await index.scan();
    await appendFile(transcript(SESSION), `${assistant('a1', 'beta words')}\n`);
    await index.scan();
    expect(index.status().messages).toBe(2);
    expect(search('beta').hits).toHaveLength(1);
  });

  it('leaves a partly written last line for the next pass', async () => {
    await write(SESSION, [user('u1', 'whole line')]);
    await appendFile(transcript(SESSION), assistant('a1', 'half written').slice(0, 30));
    await index.scan();
    expect(index.status().messages).toBe(1);
    await writeFile(
      transcript(SESSION),
      `${user('u1', 'whole line')}\n${assistant('a1', 'half written')}\n`,
    );
    await index.scan();
    expect(search('half').hits).toHaveLength(1);
  });

  it('leaves tool calls out unless asked', async () => {
    await write(SESSION, [tool('t1', 'pnpm frobnicate')]);
    await index.scan();
    expect(search('frobnicate').hits).toEqual([]);

    settings = { ...settings, includeTools: true };
    index.rebuild();
    await index.scan();
    expect(search('frobnicate').hits[0]).toMatchObject({ kind: 'tool_use' });
  });

  it('indexes what the transcript reader publishes, de-duplicated against the file', async () => {
    let publish = (_stream: string, _seq: number, _chunk: string) => {};
    index.follow({
      onData: (listener) => {
        publish = listener;
        return () => {};
      },
    });
    store.upsertSession({ id: SESSION, projectId: 'acme', cwd: CWD } as ClaudeSession);
    const message: ChatMessage = {
      id: 'u1:0',
      uuid: 'u1',
      ts: T0,
      kind: 'user',
      text: 'live spoken words',
      meta: false,
    };
    publish(transcriptStreamId(SESSION), 0, JSON.stringify(message));
    publish(transcriptStreamId(SESSION), 1, 'not json');
    expect(search('spoken').hits[0]).toMatchObject({ projectId: 'acme', state: 'live' });

    await write(SESSION, [user('u1', 'live spoken words')]);
    await index.scan();
    expect(index.status().messages).toBe(1);
  });

  it('filters by project, date and status', async () => {
    store.upsertProject(project('other', '/home/dev/other'));
    await write(SESSION, [user('u1', 'shared word', T0)]);
    await write(
      OTHER,
      [user('u2', 'shared word', T0 + 1000, '/home/dev/other')],
      '/home/dev/other',
    );
    await index.scan();
    store.upsertSession({ id: OTHER, projectId: 'other', cwd: '/home/dev/other' } as ClaudeSession);

    const ids = (extra: object) => search('shared', extra).hits.map((hit) => hit.sessionId);
    expect(ids({ projectId: 'other' })).toEqual([OTHER]);
    expect(ids({ from: T0 + 500 })).toEqual([OTHER]);
    expect(ids({ to: T0 + 500 })).toEqual([SESSION]);
    expect(ids({ status: 'live' })).toEqual([OTHER]);
    expect(ids({ status: 'finished' })).toEqual([SESSION]);
    expect(ids({ status: 'archived' })).toEqual([]);
  });

  it('caps the hits per session and says when there are more', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => user(`u${i}`, `repeated word ${i}`));
    await write(SESSION, lines);
    await write(OTHER, lines.slice(0, 2));
    await index.scan();
    const all = search('repeated').hits;
    expect(all.filter((hit) => hit.sessionId === SESSION)).toHaveLength(3);
    expect(all).toHaveLength(5);
    const { hits, more } = search('repeated', { limit: 4 });
    expect(hits).toHaveLength(4);
    expect(more).toBe(true);
  });

  it('shows a message said twice in a session once', async () => {
    await write(SESSION, [user('u1', 'same follow-up'), user('u2', 'same follow-up')]);
    await index.scan();
    expect(search('follow').hits).toHaveLength(1);
  });

  it('treats search syntax as plain words', async () => {
    await write(SESSION, [user('u1', 'NEAR the column: AND a "quote" OR (brackets)')]);
    await index.scan();
    for (const q of ['NEAR(', 'column:', 'a AND', '"quote', '(brackets)', '*', '""']) {
      expect(() => search(q)).not.toThrow();
    }
    expect(search('column:').hits).toHaveLength(1);
  });

  it('drops the oldest sessions past the limit and does not read them again', async () => {
    const text = 'padding words '.repeat(200);
    await write(SESSION, [user('u1', `oldest ${text}`, T0 - 1000)]);
    await write(OTHER, [user('u2', `newest ${text}`, T0)], '/home/dev/other');
    const { utimes } = await import('node:fs/promises');
    await utimes(transcript(SESSION), new Date(T0 - 5000), new Date(T0 - 5000));
    await index.scan();
    expect(index.status().sessions).toBe(2);

    settings = { ...settings, maxBytes: index.size() - 100 };
    index.trim();
    expect(search('oldest').hits).toEqual([]);
    expect(search('newest').hits).toHaveLength(1);
    expect(index.status().trimmed).toBe(1);

    await index.scan();
    expect(search('oldest').hits).toEqual([]);
  });

  it('clears for good, until a rebuild reads everything again', async () => {
    await write(SESSION, [user('u1', 'private words', T0)]);
    await index.scan();
    now = T0 + 1000;
    index.clear();
    await index.idle();
    await index.scan();
    expect(index.status()).toMatchObject({ sessions: 0, messages: 0, bytes: 0 });
    expect(search('private').hits).toEqual([]);

    await appendFile(transcript(SESSION), `${user('u2', 'later words', T0 + 2000)}\n`);
    await index.scan();
    expect(search('later').hits).toHaveLength(1);

    index.rebuild();
    await index.idle();
    await index.scan();
    expect(search('private').hits).toHaveLength(1);
  });

  it('forgets a project, across restarts, until it comes back', async () => {
    await write(SESSION, [user('u1', 'forgettable words')]);
    await index.scan();
    index.forgetProject(store.state.projects.acme as Project);
    store.removeProject('acme');
    expect(search('forgettable').hits).toEqual([]);

    index.close();
    index = makeIndex();
    await index.scan();
    expect(search('forgettable').hits).toEqual([]);

    store.upsertProject(project('acme', CWD));
    await index.scan();
    expect(search('forgettable').hits).toHaveLength(1);
  });

  it('opens a transcript around a message, and never outside the projects folder', async () => {
    await write(SESSION, [user('u1', 'one'), assistant('a1', 'two'), user('u2', 'three')]);
    await index.scan();
    const read = await index.transcript(SESSION, 'a1:0');
    expect(read?.messages.map((m) => m.id)).toEqual(['u1:0', 'a1:0', 'u2:0']);
    expect(await index.transcript(OTHER, undefined)).toBeNull();

    store.upsertSession({
      id: OTHER,
      projectId: 'acme',
      cwd: CWD,
      transcriptPath: '/etc/secrets.jsonl',
    } as ClaudeSession);
    expect(await index.transcript(OTHER, undefined)).toBeNull();
  });
});

describe('messageWindow', () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}` }) as ChatMessage);

  it('centers on the message', async () => {
    const { messages: got, clipped } = await messageWindow(messages, 'm5', 4);
    expect(got.map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
    expect(clipped).toBe(true);
  });

  it('falls back to the end', async () => {
    const { messages: got } = await messageWindow(messages, 'gone', 3);
    expect(got.map((m) => m.id)).toEqual(['m7', 'm8', 'm9']);
  });

  it('returns everything when it fits', async () => {
    expect(await messageWindow(messages, undefined, 20)).toMatchObject({ clipped: false });
  });
});

describe('ftsQuery', () => {
  it('quotes every word and prefixes the last', () => {
    expect(ftsQuery('cart total')).toBe('"cart" "total"*');
  });
  it('keeps phrases, closed or not', () => {
    expect(ftsQuery('"cart total" tax')).toBe('"cart total" "tax"*');
    expect(ftsQuery('"cart to')).toBe('"cart to"');
  });
  it('has nothing to search in punctuation alone', () => {
    expect(ftsQuery('*** ( "')).toBeNull();
  });
});

describe('snippetRuns', () => {
  it('splits marks into runs and flattens line breaks', () => {
    expect(snippetRuns('a\n b hit c')).toEqual([
      { text: 'a b ', hit: false },
      { text: 'hit', hit: true },
      { text: ' c', hit: false },
    ]);
  });
});

describe('searchableText', () => {
  const base = { id: 'x', uuid: null, ts: null };
  it('leaves out injected messages and thinking', () => {
    expect(searchableText({ ...base, kind: 'user', text: 'x', meta: true }, true)).toBeNull();
    expect(
      searchableText(
        { ...base, kind: 'thinking', text: 'x', messageId: null, model: null, usage: null },
        true,
      ),
    ).toBeNull();
  });
  it('strips the characters that mark a highlight', () => {
    expect(searchableText({ ...base, kind: 'user', text: 'ab', meta: false }, false)).toBe('a b');
  });
});
