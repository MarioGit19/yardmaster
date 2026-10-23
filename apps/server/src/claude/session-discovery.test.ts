import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectIdFromPath } from '@c-board/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardStore } from '../store.js';
import { type HistoryLister, processAlive, SessionDiscovery } from './session-discovery.js';
import { sessionReducer } from './session-reducer.js';

const logger = { warn: () => {}, debug: () => {} };
const CWD = '/home/dev/acme-shop';
const LIVE_ID = '0b6f6a52-3c1e-4d7a-9f0e-5a1b2c3d4e01';
const DEAD_ID = '0b6f6a52-3c1e-4d7a-9f0e-5a1b2c3d4e02';
const OTHER_ID = '0b6f6a52-3c1e-4d7a-9f0e-5a1b2c3d4e03';

let dir: string;
let registry: string;
const services: SessionDiscovery[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c-board-registry-'));
  registry = join(dir, 'sessions');
  await mkdir(registry);
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  await rm(dir, { recursive: true, force: true });
});

function entry(pid: number, sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    pid,
    sessionId,
    cwd: CWD,
    status: 'idle',
    kind: 'interactive',
    entrypoint: 'cli',
    startedAt: 1,
    messagingSocketPath: '/tmp/fake.sock',
    ...extra,
  };
}

async function writeEntry(pid: number, sessionId: string, extra: Record<string, unknown> = {}) {
  await writeFile(join(registry, `${pid}.json`), JSON.stringify(entry(pid, sessionId, extra)));
}

function setup(
  options: { alive?: Set<number>; listHistory?: HistoryLister | null; registryDir?: string } = {},
) {
  const alive = options.alive ?? new Set<number>();
  let now = 1_000;
  const store = new BoardStore({ now: () => now });
  const service = new SessionDiscovery({
    store,
    logger,
    registryDir: options.registryDir ?? registry,
    isAlive: (pid) => alive.has(pid),
    listHistory: options.listHistory ?? null,
    now: () => now,
    resolvePath: async (path) => path,
  });
  services.push(service);
  return {
    store,
    service,
    alive,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('SessionDiscovery registry scan', () => {
  it('upserts live sessions as terminal sessions with their project', async () => {
    await writeEntry(101, LIVE_ID, { status: 'busy', name: 'fix the  cart\ntotals' });
    const { store, service } = setup({ alive: new Set([101]) });
    await service.tick();

    const session = store.state.sessions[LIVE_ID];
    expect(session).toMatchObject({
      origin: 'terminal',
      cwd: CWD,
      claudePid: 101,
      title: null,
      customTitle: 'fix the cart totals',
      status: { kind: 'working' },
      projectId: projectIdFromPath(CWD),
      endedAt: null,
    });
    expect(store.state.projects[projectIdFromPath(CWD)]).toMatchObject({
      path: CWD,
      source: 'hook',
    });
  });

  it("keeps Claude Code's automatic name as the title and picks up a rename", async () => {
    const automatic = `${CWD.split('/').pop()}-c3`;
    await writeEntry(101, LIVE_ID, { name: automatic });
    const { store, service, advance } = setup({ alive: new Set([101]) });
    await service.tick();
    expect(store.state.sessions[LIVE_ID]).toMatchObject({
      title: automatic,
      customTitle: null,
      ordinal: 1,
    });

    await writeEntry(101, LIVE_ID, { name: 'Checkout refactor' });
    advance(1_000);
    await service.tick();
    expect(store.state.sessions[LIVE_ID]).toMatchObject({
      title: automatic,
      customTitle: 'Checkout refactor',
    });
  });

  it('ignores files whose process is dead and that the board never saw', async () => {
    await writeEntry(102, DEAD_ID);
    const { store, service } = setup();
    await service.tick();
    expect(store.state.sessions[DEAD_ID]).toBeUndefined();
  });

  it('marks a session ended once its process is gone', async () => {
    await writeEntry(101, LIVE_ID);
    const { store, service, alive, advance } = setup({ alive: new Set([101]) });
    await service.tick();
    expect(store.state.sessions[LIVE_ID]?.status.kind).toBe('idle');

    alive.delete(101);
    advance(10_000);
    await service.tick();
    expect(store.state.sessions[LIVE_ID]).toMatchObject({
      status: { kind: 'ended' },
      endedAt: 11_000,
    });
  });

  it('ends a discovered session when its file disappears with the process', async () => {
    await writeEntry(101, LIVE_ID);
    const { store, service, alive } = setup({ alive: new Set([101]) });
    await service.tick();

    await rm(join(registry, '101.json'));
    await service.tick();
    expect(store.state.sessions[LIVE_ID]?.status.kind).toBe('idle');

    alive.delete(101);
    await service.tick();
    expect(store.state.sessions[LIVE_ID]?.status.kind).toBe('ended');
  });

  it('skips malformed, unreadable and foreign files without failing the scan', async () => {
    await writeFile(join(registry, '201.json'), '{"pid": 201, "sessionId": ');
    await writeFile(join(registry, '202.json'), JSON.stringify({ pid: 'x', sessionId: OTHER_ID }));
    await writeFile(join(registry, '203.json'), JSON.stringify([1, 2, 3]));
    await writeFile(join(registry, '204.json'), JSON.stringify({ sessionId: OTHER_ID }));
    await writeFile(join(registry, '205.json'), 'x'.repeat(100 * 1024));
    await writeFile(join(registry, 'notes.txt'), 'not json');
    await mkdir(join(registry, '206.json'));
    await writeEntry(101, LIVE_ID, { cwd: 42, name: { nested: true } });
    const { store, service } = setup({ alive: new Set([101, 201, 202, 204, 205]) });
    await service.tick();

    expect(Object.keys(store.state.sessions)).toEqual([LIVE_ID]);
    expect(store.state.sessions[LIVE_ID]).toMatchObject({
      cwd: null,
      title: null,
      projectId: null,
    });
  });

  it('does nothing when the registry is missing', async () => {
    const { store, service } = setup({ registryDir: join(dir, 'absent') });
    await service.tick();
    expect(store.state.sessions).toEqual({});
  });

  it('follows registry status until hooks take over', async () => {
    await writeEntry(101, LIVE_ID, { status: 'busy' });
    const { store, service, advance } = setup({ alive: new Set([101]) });
    await service.tick();

    await writeEntry(101, LIVE_ID, { status: 'idle' });
    advance(1_000);
    await service.tick();
    expect(store.state.sessions[LIVE_ID]?.status.kind).toBe('idle');

    // A hook event now drives the session; the registry must not override it.
    advance(1_000);
    const hooked = sessionReducer(store.state.sessions[LIVE_ID], {
      common: { session_id: LIVE_ID, hook_event_name: 'UserPromptSubmit' },
      hook: { session_id: LIVE_ID, hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      ts: 3_000,
    });
    store.upsertSession(hooked);
    advance(1_000);
    await service.tick();
    expect(store.state.sessions[LIVE_ID]?.status.kind).toBe('working');
  });

  it('only fills gaps in sessions the hooks already reported', async () => {
    const { store, service } = setup({ alive: new Set([101]) });
    store.upsertSession({
      id: LIVE_ID,
      origin: 'board',
      title: 'from hooks',
      status: { kind: 'tool', tool: 'Bash', toolUseId: null },
      updatedAt: 500,
    });
    await writeEntry(101, LIVE_ID, { name: 'registry name' });
    await service.tick();

    expect(store.state.sessions[LIVE_ID]).toMatchObject({
      origin: 'board',
      title: 'from hooks',
      claudePid: 101,
      cwd: CWD,
      projectId: projectIdFromPath(CWD),
      status: { kind: 'tool' },
      updatedAt: 500,
    });
  });

  it('does not end a session that hooks tied to a newer process', async () => {
    const { store, service } = setup();
    store.upsertSession({ id: LIVE_ID, claudePid: 300, status: { kind: 'idle' } });
    await writeEntry(101, LIVE_ID);
    await service.tick();
    expect(store.state.sessions[LIVE_ID]?.status.kind).toBe('idle');
  });

  it('prefers the live entry when a session appears twice', async () => {
    await writeEntry(101, LIVE_ID);
    await writeEntry(102, LIVE_ID);
    const { store, service } = setup({ alive: new Set([102]) });
    await service.tick();
    expect(store.state.sessions[LIVE_ID]).toMatchObject({
      claudePid: 102,
      status: { kind: 'idle' },
    });
  });

  it('revives an ended session resumed in a new process', async () => {
    const { store, service } = setup({ alive: new Set([102]) });
    store.upsertSession({ id: LIVE_ID, claudePid: 101, status: { kind: 'ended' }, endedAt: 900 });
    await writeEntry(102, LIVE_ID, { status: 'busy' });
    await service.tick();
    expect(store.state.sessions[LIVE_ID]).toMatchObject({
      claudePid: 102,
      status: { kind: 'working' },
      endedAt: null,
    });
  });

  it('leaves an ended session alone while its old process exits', async () => {
    const { store, service } = setup({ alive: new Set([101]) });
    store.upsertSession({ id: LIVE_ID, claudePid: 101, status: { kind: 'ended' }, endedAt: 900 });
    await writeEntry(101, LIVE_ID);
    await service.tick();
    expect(store.state.sessions[LIVE_ID]?.status.kind).toBe('ended');
  });

  it('scans on start and on every interval', async () => {
    vi.useFakeTimers();
    try {
      const store = new BoardStore();
      const isAlive = vi.fn(() => true);
      const service = new SessionDiscovery({
        store,
        logger,
        registryDir: registry,
        isAlive,
        listHistory: null,
        intervalMs: 10_000,
        resolvePath: async (path) => path,
      });
      services.push(service);
      await writeEntry(101, LIVE_ID);
      const tick = vi.spyOn(service, 'tick');
      service.start();
      expect(tick).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(tick).toHaveBeenCalledTimes(2);
      await service.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SessionDiscovery history', () => {
  const PROJECT = '/home/dev/acme-shop';

  function withProject(store: BoardStore) {
    const id = projectIdFromPath(PROJECT);
    store.upsertProject({
      id,
      path: PROJECT,
      name: 'acme-shop',
      accent: 0,
      source: 'manual',
      git: null,
      createdAt: 1,
      lastActivityAt: 1,
    });
    return id;
  }

  it('lists recent sessions per project through the lister, newest first', async () => {
    const listHistory = vi.fn<HistoryLister>(async () => [
      { sessionId: OTHER_ID, summary: 'Older work', lastModified: 100, fileSize: 2048 },
      {
        sessionId: LIVE_ID,
        summary: 'auto summary',
        customTitle: 'Checkout\nrefactor',
        firstPrompt: 'refactor checkout',
        gitBranch: 'main',
        cwd: PROJECT,
        lastModified: 500,
        createdAt: 400,
      },
      { sessionId: 7, lastModified: 'yesterday' },
      null,
    ]);
    const { store, service } = setup({ listHistory });
    const projectId = withProject(store);
    await service.tick();

    expect(listHistory).toHaveBeenCalledWith(PROJECT, 20);
    expect(service.history(projectId)).toEqual([
      {
        id: LIVE_ID,
        projectId,
        title: 'Checkout refactor',
        firstPrompt: 'refactor checkout',
        cwd: PROJECT,
        gitBranch: 'main',
        createdAt: 400,
        updatedAt: 500,
        fileSize: null,
        tokens: null,
      },
      {
        id: OTHER_ID,
        projectId,
        title: 'Older work',
        firstPrompt: null,
        cwd: null,
        gitBranch: null,
        createdAt: null,
        updatedAt: 100,
        fileSize: 2048,
        tokens: null,
      },
    ]);
  });

  it('reuses a fresh listing and keeps the last one when the lister fails', async () => {
    let fail = false;
    const listHistory = vi.fn<HistoryLister>(async () => {
      if (fail) throw new Error('boom');
      return [{ sessionId: LIVE_ID, summary: 'Work', lastModified: 1 }];
    });
    const { store, service, advance } = setup({ listHistory });
    const projectId = withProject(store);
    await service.tick();
    await service.tick();
    expect(listHistory).toHaveBeenCalledTimes(1);

    fail = true;
    advance(60_000);
    await service.tick();
    expect(listHistory).toHaveBeenCalledTimes(2);
    expect(service.history(projectId).map((e) => e.id)).toEqual([LIVE_ID]);
  });

  it('lists on demand only when the cached listing is stale', async () => {
    const listHistory = vi.fn<HistoryLister>(async () => [
      { sessionId: LIVE_ID, summary: 'Work', lastModified: 1 },
    ]);
    const { store, service, advance } = setup({ listHistory });
    const projectId = withProject(store);
    expect((await service.freshHistory(projectId)).map((e) => e.id)).toEqual([LIVE_ID]);
    await service.freshHistory(projectId);
    expect(listHistory).toHaveBeenCalledTimes(1);
    advance(60_000);
    await service.freshHistory(projectId);
    expect(listHistory).toHaveBeenCalledTimes(2);
  });

  it('returns nothing for unknown projects', async () => {
    const { service } = setup({ listHistory: async () => [] });
    expect(await service.loadHistory('nope')).toEqual([]);
    expect(service.history('nope')).toEqual([]);
  });
});

describe('processAlive', () => {
  it('sees the current process and not a free pid', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12_345)).toBe(false);
  });
});
