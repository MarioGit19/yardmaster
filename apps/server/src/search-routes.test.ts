import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './app.js';
import { encodeProjectDir } from './claude/transcript-service.js';
import type { ServerConfig } from './config.js';

const TOKEN = 'search-route-token';
const SESSION = '33333333-3333-4333-8333-333333333333';
const CWD = '/home/dev/acme-shop';

describe('search routes', () => {
  let home: string;
  let app: Awaited<ReturnType<typeof buildServer>>;
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, token: string | null = TOKEN) =>
    app.inject({
      method,
      url,
      headers: {
        host: '127.0.0.1:4317',
        ...(token ? { 'x-yardmaster-token': token } : {}),
      },
    });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ym-search-'));
    const folder = join(home, 'claude', 'projects', encodeProjectDir(CWD));
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, `${SESSION}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        uuid: 'u1',
        cwd: CWD,
        message: { role: 'user', content: 'Where is the invoice template?' },
      })}\n`,
    );
    const config: ServerConfig = {
      home,
      port: 4317,
      host: '127.0.0.1',
      logLevel: 'silent',
      devOrigins: [],
    };
    app = await buildServer(config, {
      token: TOKEN,
      dbPath: ':memory:',
      transcripts: {
        loadHistory: null,
        watchFile: () => async () => {},
        claudeConfigDir: join(home, 'claude'),
      },
      discovery: { listHistory: null, listAgents: null, registryDir: join(home, 'none') },
      processes: false,
      git: false,
    });
    await app.transcriptIndex.scan();
  });

  afterEach(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
  });

  it('needs a sign-in', async () => {
    expect((await call('GET', '/api/search?q=invoice', null)).statusCode).toBe(401);
    expect((await call('GET', '/api/search/index', null)).statusCode).toBe(401);
    expect((await call('DELETE', '/api/search/index', null)).statusCode).toBe(401);
  });

  it('rejects bad input without throwing', async () => {
    expect((await call('GET', '/api/search')).statusCode).toBe(400);
    expect((await call('GET', '/api/search?q=x&status=nope')).statusCode).toBe(400);
    expect((await call('GET', `/api/search?q=${'x'.repeat(201)}`)).statusCode).toBe(400);
  });

  it('finds a message and opens the transcript at it', async () => {
    const found = await call('GET', '/api/search?q=invoice');
    expect(found.headers['cache-control']).toBe('no-store');
    const [hit] = found.json().hits;
    expect(hit).toMatchObject({ sessionId: SESSION, messageId: 'u1:0' });

    const read = await call('GET', `/api/search/sessions/${SESSION}?around=u1:0`);
    expect(read.json().messages).toHaveLength(1);
    expect((await call('GET', '/api/search/sessions/unknown')).statusCode).toBe(404);
  });

  it('reports the index and clears it', async () => {
    expect((await call('GET', '/api/search/index')).json()).toMatchObject({
      sessions: 1,
      messages: 1,
      maxBytes: 500 * 1024 * 1024,
    });
    expect((await call('DELETE', '/api/search/index')).json()).toEqual({ ok: true });
    await app.transcriptIndex.idle();
    expect((await call('GET', '/api/search?q=invoice')).json().hits).toEqual([]);
  });
});
