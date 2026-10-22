import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIT_INTERVAL_MS, type GitRunner, GitScanner, NOT_REPO_RECHECK_MS } from './git-scanner.js';
import { BoardStore } from './store.js';

const T0 = 1_760_000_000_000;
const OID = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';
const z = (...records: string[]) => `${records.join('\0')}\0`;

const STATUS = z(
  `# branch.oid ${OID}`,
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -0',
  '? notes.md',
);
const LOG = z([OID, 'Dev One', '1760000000', 'Initial commit'].join('\x1f'));

function gitError(stderr: string): Error {
  return Object.assign(new Error('Command failed'), { code: 128, stderr });
}

interface Repo {
  status: string | Error;
  log?: string | Error;
}

function setup(repos: Record<string, Repo>, active = true) {
  const store = new BoardStore({ autoFlush: false, now: () => T0 });
  for (const [name, _repo] of Object.entries(repos)) {
    store.upsertProject({
      id: `p-${name}`,
      path: `/home/dev/${name}`,
      name,
      accent: 0,
      source: 'editor',
      git: null,
      createdAt: T0,
      lastActivityAt: null,
    });
  }
  store.flush();
  const calls: string[] = [];
  const run: GitRunner = async (dir, args) => {
    calls.push(`${dir} ${args[0]}`);
    const repo = repos[dir.slice('/home/dev/'.length)];
    const out = args[0] === 'status' ? repo?.status : repo?.log;
    if (out === undefined) throw gitError(`fatal: cannot change to '${dir}'`);
    if (out instanceof Error) throw out;
    return out;
  };
  const logger = { warn: vi.fn(), debug: vi.fn() };
  let now = T0;
  const state = { active };
  const scanner = new GitScanner({
    store,
    logger,
    run,
    active: () => state.active,
    now: () => now,
  });
  return { store, scanner, calls, logger, state, tick: (ms: number) => (now += ms) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GitScanner', () => {
  it('fills GitInfo from status and log', async () => {
    const { store, scanner } = setup({ shop: { status: STATUS, log: LOG } });
    await scanner.tick();
    expect(store.state.projects['p-shop']?.git).toEqual({
      branch: 'main',
      head: OID,
      detached: false,
      dirty: 1,
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      files: [
        { path: 'notes.md', origPath: null, status: 'untracked', staged: false, unstaged: true },
      ],
      commits: [{ hash: OID, author: 'Dev One', at: 1_760_000_000_000, subject: 'Initial commit' }],
      updatedAt: T0,
    });
  });

  it('only polls while a UI client is connected', async () => {
    const { store, scanner, calls, state } = setup({ shop: { status: STATUS, log: LOG } }, false);
    await scanner.tick();
    expect(calls).toEqual([]);
    expect(store.state.projects['p-shop']?.git).toBeNull();
    state.active = true;
    await scanner.tick();
    expect(calls).toEqual(['/home/dev/shop status', '/home/dev/shop log']);
  });

  it('writes nothing when the repository is unchanged', async () => {
    const { store, scanner, tick } = setup({ shop: { status: STATUS, log: LOG } });
    await scanner.tick();
    store.flush();
    tick(GIT_INTERVAL_MS);
    await scanner.tick();
    expect(store.flush()).toEqual([]);
    expect(store.state.projects['p-shop']?.git?.updatedAt).toBe(T0);
  });

  it('skips the log for a repository without commits', async () => {
    const { store, scanner, calls } = setup({
      fresh: { status: z('# branch.oid (initial)', '# branch.head main') },
    });
    await scanner.tick();
    expect(calls).toEqual(['/home/dev/fresh status']);
    expect(store.state.projects['p-fresh']?.git).toMatchObject({ head: null, commits: [] });
  });

  it('skips folders outside git and rechecks them later', async () => {
    const { store, scanner, calls, logger, tick } = setup({
      notes: { status: gitError('fatal: not a git repository (or any parent): .git') },
    });
    await scanner.tick();
    await scanner.tick();
    expect(calls).toEqual(['/home/dev/notes status']);
    expect(store.state.projects['p-notes']?.git).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
    tick(NOT_REPO_RECHECK_MS);
    await scanner.tick();
    expect(calls).toHaveLength(2);
  });

  it('clears git info when a folder stops being a repository', async () => {
    const repos: Record<string, Repo> = { shop: { status: STATUS, log: LOG } };
    const { store, scanner } = setup(repos);
    await scanner.tick();
    expect(store.state.projects['p-shop']?.git).not.toBeNull();
    repos.shop = { status: gitError('fatal: not a git repository') };
    await scanner.tick();
    expect(store.state.projects['p-shop']?.git).toBeNull();
  });

  it('keeps the last info when git fails, and warns once', async () => {
    const repos: Record<string, Repo> = { shop: { status: STATUS, log: LOG } };
    const { store, scanner, logger } = setup(repos);
    await scanner.tick();
    const before = store.state.projects['p-shop']?.git;
    repos.shop = { status: gitError('fatal: detected dubious ownership') };
    await scanner.tick();
    await scanner.tick();
    expect(store.state.projects['p-shop']?.git).toBe(before);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('turns itself off when git is not installed', async () => {
    const { scanner, calls, logger } = setup({
      shop: { status: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) },
    });
    await scanner.tick();
    await scanner.tick();
    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('coalesces hook-triggered refreshes, even without clients', async () => {
    vi.useFakeTimers();
    const { store, scanner, calls } = setup({ shop: { status: STATUS, log: LOG } }, false);
    scanner.request('p-shop');
    scanner.request('p-shop');
    scanner.request('p-shop');
    await vi.runOnlyPendingTimersAsync();
    expect(calls).toEqual(['/home/dev/shop status', '/home/dev/shop log']);
    expect(store.state.projects['p-shop']?.git?.branch).toBe('main');
  });

  it('rescans once more when asked during a scan', async () => {
    let release: () => void = () => {};
    const { store } = setup({});
    store.upsertProject({
      id: 'p-shop',
      path: '/home/dev/shop',
      name: 'shop',
      accent: 0,
      source: 'editor',
      git: null,
      createdAt: T0,
      lastActivityAt: null,
    });
    let statusCalls = 0;
    const scanner = new GitScanner({
      store,
      logger: { warn: vi.fn(), debug: vi.fn() },
      active: () => true,
      now: () => T0,
      run: async (_dir, args) => {
        if (args[0] === 'log') return LOG;
        statusCalls += 1;
        if (statusCalls === 1) await new Promise<void>((resolve) => (release = resolve));
        return STATUS;
      },
    });
    const first = scanner.scan('p-shop');
    void scanner.scan('p-shop');
    void scanner.scan('p-shop');
    release();
    await first;
    await vi.waitFor(() => expect(statusCalls).toBe(2));
  });

  it('drops results for a project removed mid-scan', async () => {
    const { store, scanner } = setup({ shop: { status: STATUS, log: LOG } });
    const scan = scanner.scan('p-shop');
    store.removeProject('p-shop');
    await scan;
    expect(store.state.projects['p-shop']).toBeUndefined();
  });

  it('drops results after stop', async () => {
    const { store, scanner } = setup({ shop: { status: STATUS, log: LOG } });
    const scan = scanner.scan('p-shop');
    scanner.stop();
    await scan;
    expect(store.state.projects['p-shop']?.git).toBeNull();
  });
});
