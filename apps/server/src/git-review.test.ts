import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Project,
  projectIdFromPath,
  REVIEW_ERRORS,
  worktreeContaining,
} from '@yardmaster/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGitWorktrees } from './git.js';
import {
  addedPatch,
  createReviewActions,
  discardSteps,
  GitReviewer,
  parseNumstat,
  parsePullRequest,
  splitPatch,
  worktreeFlagProbe,
} from './git-review.js';
import { GitScanner, runGit } from './git-scanner.js';
import { BoardStore } from './store.js';

const logger = { warn: () => {}, debug: () => {} };

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

function project(path: string): Project {
  return {
    id: projectIdFromPath(path),
    path,
    name: 'acme-shop',
    accent: 0,
    source: 'hook',
    git: null,
    createdAt: 1,
    lastActivityAt: 1,
  };
}

describe('parsers', () => {
  it('reads numstat records, renames and binary files', () => {
    const out = '3\t1\tsrc/a.ts\0-\t-\tlogo.png\x000\t0\t\0old.ts\0new.ts\0';
    expect(parseNumstat(out)).toEqual([
      { path: 'src/a.ts', origPath: null, added: 3, removed: 1, binary: false },
      { path: 'logo.png', origPath: null, added: 0, removed: 0, binary: true },
      { path: 'new.ts', origPath: 'old.ts', added: 0, removed: 0, binary: false },
    ]);
    expect(parseNumstat('not a record\0')).toEqual([]);
  });

  it('does not cut a patch at a line that only quotes a diff header', () => {
    const patch = 'diff --git a/a b/a\n@@ -1 +1 @@\n-diff --git x y\n+z\ndiff --git a/b b/b\n';
    expect(splitPatch(patch)).toHaveLength(2);
  });

  it('turns text into an added patch and refuses binary', () => {
    expect(addedPatch('a\nb\n')).toEqual({ patch: '@@ -0,0 +1,2 @@\n+a\n+b\n', lines: 2 });
    expect(addedPatch('a\0b')).toBeNull();
    expect(addedPatch('')).toEqual({ patch: '', lines: 0 });
  });

  it('lists worktrees, main first, without bare or prunable ones', () => {
    const out = [
      'worktree /home/dev/acme-shop\0HEAD abcdef1\0branch refs/heads/main\0',
      'worktree /home/dev/acme-shop/.claude/worktrees/tax\0HEAD abcdef2\0branch refs/heads/fix/tax\0',
      'worktree /home/dev/gone\0HEAD abcdef3\0detached\0prunable gitdir file missing\0',
      'worktree /home/dev/pinned\0HEAD abcdef4\0detached\0',
      '',
    ].join('\0');
    const listed = parseGitWorktrees(out);
    expect(listed.map((w) => [w.path, w.branch, w.main])).toEqual([
      ['/home/dev/acme-shop', 'main', true],
      ['/home/dev/acme-shop/.claude/worktrees/tax', 'fix/tax', false],
      ['/home/dev/pinned', null, false],
    ]);
    expect(
      worktreeContaining(listed, '/home/dev/acme-shop/.claude/worktrees/tax/src')?.branch,
    ).toBe('fix/tax');
    expect(worktreeContaining(listed, '/home/dev/acme-shop/src')?.main).toBe(true);
    expect(worktreeContaining(listed, '/home/dev/acme-shopper')).toBeNull();
  });

  it('reads a pull request and its checks, and ignores anything else', () => {
    const pr = (extra: object) =>
      JSON.stringify({
        number: 7,
        title: 'Fix tax',
        url: 'https://github.example/acme/shop/pull/7',
        state: 'OPEN',
        isDraft: false,
        ...extra,
      });
    expect(parsePullRequest(pr({ statusCheckRollup: [] }))).toMatchObject({
      number: 7,
      state: 'open',
      checks: 'none',
    });
    expect(
      parsePullRequest(
        pr({ statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }] }),
      )?.checks,
    ).toBe('failing');
    expect(
      parsePullRequest(pr({ statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] }))
        ?.checks,
    ).toBe('pending');
    expect(parsePullRequest(pr({ isDraft: true }))?.state).toBe('draft');
    expect(parsePullRequest(pr({ url: 'http://github.example/insecure' }))).toBeNull();
    expect(parsePullRequest('no pull requests found')).toBeNull();
  });

  it('undoes each kind of change with the right command', () => {
    const change = (status: 'modified' | 'added' | 'untracked' | 'renamed', origPath?: string) => ({
      path: 'b.ts',
      origPath: origPath ?? null,
      status,
      staged: true,
      unstaged: false,
    });
    expect(discardSteps(change('untracked'), true)).toEqual([['clean', '-f', '--', 'b.ts']]);
    expect(discardSteps(change('added'), true)).toEqual([['rm', '-f', '--', 'b.ts']]);
    expect(discardSteps(change('modified'), false)).toEqual([['rm', '-f', '--', 'b.ts']]);
    expect(discardSteps(change('modified'), true)[0]?.slice(0, 2)).toEqual([
      'restore',
      '--source=HEAD',
    ]);
    expect(discardSteps(change('renamed', 'a.ts'), true)).toHaveLength(2);
  });
});

describe('worktreeFlagProbe', () => {
  it('finds the flag, and asks again after a no', async () => {
    const help = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('  --verbose  Override')
      .mockResolvedValue('  -w, --worktree [name]  Create a new git worktree');
    const probe = worktreeFlagProbe(help);
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(true);
    expect(await probe()).toBe(true);
    expect(help).toHaveBeenCalledTimes(2);
  });

  it('reads a missing claude as no flag', async () => {
    expect(await worktreeFlagProbe(() => Promise.reject(new Error('ENOENT')))()).toBe(false);
  });
});

describe('session.parallel', () => {
  const source = {} as never;

  it('opens a terminal running the claude flag, a fixed command line', async () => {
    const terminalCreate = vi.fn(async () => ({ ok: true as const }));
    const actions = createReviewActions({
      source,
      parallel: async () => true,
      terminalCreate,
    });
    await actions['session.parallel']({ kind: 'session.parallel', projectId: 'p1' });
    expect(terminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', command: 'claude --worktree' }),
    );
  });

  it('refuses when the installed claude has no such flag', async () => {
    const terminalCreate = vi.fn(async () => ({ ok: true as const }));
    const actions = createReviewActions({
      source,
      parallel: async () => false,
      terminalCreate,
    });
    expect(
      await actions['session.parallel']({ kind: 'session.parallel', projectId: 'p1' }),
    ).toEqual({ ok: false, error: REVIEW_ERRORS.noWorktreeFlag });
    expect(terminalCreate).not.toHaveBeenCalled();
  });
});

describe('GitReviewer on a real repository', { timeout: 30_000 }, () => {
  let home: string;
  let repo: string;
  let store: BoardStore;
  let reviewer: GitReviewer;
  let id: string;

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'yardmaster-review-')));
    // The test's git never sees the machine's own config or signing.
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
    repo = join(home, 'acme-shop');
    await mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Dev');
    git(repo, 'config', 'user.email', 'dev@example.com');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'cart.ts'), 'one\ntwo\nthree\n');
    writeFileSync(join(repo, 'tax.ts'), 'rate\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'start');
    store = new BoardStore();
    store.upsertProject(project(repo));
    id = projectIdFromPath(repo);
    reviewer = new GitReviewer({ store, logger, parallel: async () => true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const read = async (worktree: string | null = null) => {
    const outcome = await reviewer.read(id, worktree);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.review;
  };

  it('compares a branch with its merge base, not the tip of main', async () => {
    git(repo, 'switch', '-q', '-c', 'fix/tax');
    writeFileSync(join(repo, 'tax.ts'), 'rate\nvat\n');
    git(repo, 'commit', '-qam', 'vat');
    git(repo, 'switch', '-q', 'main');
    writeFileSync(join(repo, 'cart.ts'), 'moved on\n');
    git(repo, 'commit', '-qam', 'main moves');
    git(repo, 'switch', '-q', 'fix/tax');
    writeFileSync(join(repo, 'notes.md'), 'hello\nworld\n');

    const review = await read();
    expect(review.base.ref).toBe('main');
    expect(review.files.map((f) => [f.path, f.status, f.added, f.removed, f.uncommitted])).toEqual([
      ['notes.md', 'untracked', 2, 0, true],
      ['tax.ts', 'modified', 1, 0, false],
    ]);
    expect(review.files[1]?.patch).toMatch(/^@@ .*\n rate\n\+vat\n$/);
  });

  it('marks renames, deletions and binary files', async () => {
    git(repo, 'mv', 'tax.ts', 'duty.ts');
    git(repo, 'rm', '-q', 'cart.ts');
    writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 0]));
    const review = await read();
    const byPath = new Map(review.files.map((f) => [f.path, f]));
    expect(byPath.get('duty.ts')).toMatchObject({ status: 'renamed', origPath: 'tax.ts' });
    expect(byPath.get('cart.ts')).toMatchObject({ status: 'deleted', removed: 3 });
    expect(byPath.get('logo.bin')).toMatchObject({ binary: true, patch: null });
  });

  it('never follows an untracked link', async () => {
    writeFileSync(join(home, 'secret.txt'), 'outside the repository\n');
    symlinkSync(join(home, 'secret.txt'), join(repo, 'link.txt'));
    const review = await read();
    expect(review.files.find((f) => f.path === 'link.txt')).toMatchObject({ patch: null });
  });

  it('changes the sig and revision when a file changes', async () => {
    writeFileSync(join(repo, 'cart.ts'), 'one\n');
    const first = await read();
    writeFileSync(join(repo, 'cart.ts'), 'two\n');
    const second = await read();
    expect(second.revision).not.toBe(first.revision);
    expect(second.files[0]?.sig).not.toBe(first.files[0]?.sig);
  });

  it('refuses a repository whose config runs commands, and turns diff drivers off', async () => {
    writeFileSync(join(repo, 'cart.ts'), 'edited\n');
    const marker = join(home, 'ran');
    git(repo, 'config', 'diff.external', `sh -c 'touch ${marker}'`);
    await read();
    expect(() => execFileSync('test', ['-e', marker])).toThrow();

    git(repo, 'config', 'filter.lfs.clean', `sh -c 'touch ${marker}'`);
    expect(await reviewer.read(id, null)).toEqual({
      ok: false,
      error: REVIEW_ERRORS.configRunsCommands,
    });
  });

  it('commits only what the review showed, in the repository’s own identity', async () => {
    writeFileSync(join(repo, 'cart.ts'), 'edited\n');
    writeFileSync(join(repo, 'fresh.ts'), 'new\n');
    git(repo, 'rm', '-q', 'tax.ts');
    const { revision } = await read();
    const result = await reviewer.commit({
      kind: 'git.commit',
      projectId: id,
      revision,
      message: 'feat: tidy the cart',
    });
    expect(result).toEqual({ ok: true });
    expect(git(repo, 'log', '-1', '--format=%an %s').trim()).toBe('Dev feat: tidy the cart');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n')).toEqual([
      'M\tcart.ts',
      'A\tfresh.ts',
      'D\ttax.ts',
    ]);
  });

  it('refuses a commit or discard of a review that went stale', async () => {
    writeFileSync(join(repo, 'cart.ts'), 'edited\n');
    const { revision } = await read();
    writeFileSync(join(repo, 'cart.ts'), 'edited again\n');
    const stale = { ok: false, error: REVIEW_ERRORS.changed };
    expect(
      await reviewer.commit({ kind: 'git.commit', projectId: id, revision, message: 'm' }),
    ).toEqual(stale);
    expect(
      await reviewer.discard({ kind: 'git.discard', projectId: id, revision, path: 'cart.ts' }),
    ).toEqual(stale);
    expect(git(repo, 'log', '--oneline').trim().split('\n')).toHaveLength(1);
  });

  it('reports what git said when a hook rejects the commit', async () => {
    writeFileSync(
      join(repo, '.git/hooks/pre-commit'),
      '#!/bin/sh\necho "lint failed" >&2\nexit 1\n',
      {
        mode: 0o755,
      },
    );
    writeFileSync(join(repo, 'cart.ts'), 'edited\n');
    const { revision } = await read();
    const result = await reviewer.commit({
      kind: 'git.commit',
      projectId: id,
      revision,
      message: 'm',
    });
    expect(result).toMatchObject({ ok: false, error: REVIEW_ERRORS.commitFailed });
    expect(result.ok === false && result.detail).toContain('lint failed');
  });

  it('discards a changed, an added and an untracked file, and nothing else', async () => {
    writeFileSync(join(repo, 'cart.ts'), 'edited\n');
    writeFileSync(join(repo, 'tax.ts'), 'edited too\n');
    writeFileSync(join(repo, 'staged.ts'), 'added\n');
    git(repo, 'add', 'staged.ts');
    writeFileSync(join(repo, 'stray.ts'), 'untracked\n');
    for (const path of ['cart.ts', 'staged.ts', 'stray.ts']) {
      const { revision } = await read();
      expect(
        await reviewer.discard({ kind: 'git.discard', projectId: id, revision, path }),
      ).toEqual({ ok: true });
    }
    expect(git(repo, 'status', '--porcelain').trim()).toBe('M tax.ts');
  });

  it('refuses to discard a path the review does not list', async () => {
    writeFileSync(join(repo, 'cart.ts'), 'edited\n');
    const { revision } = await read();
    for (const path of ['tax.ts', '../outside.txt', ':(glob)**']) {
      expect(
        await reviewer.discard({ kind: 'git.discard', projectId: id, revision, path }),
      ).toEqual({ ok: false, error: REVIEW_ERRORS.notDiscardable });
    }
    expect(git(repo, 'status', '--porcelain').trim()).toBe('M cart.ts');
  });

  it('reviews and commits inside a worktree the repository lists', async () => {
    const linked = join(home, 'acme-shop-tax');
    git(repo, 'worktree', 'add', '-q', '-b', 'fix/tax', linked);
    writeFileSync(join(linked, 'tax.ts'), 'vat\n');
    const worktree = projectIdFromPath(linked);

    const review = await read(worktree);
    expect(review.branch).toBe('fix/tax');
    expect(review.base.ref).toBe('main');
    expect(review.files.map((f) => f.path)).toEqual(['tax.ts']);

    const done = await reviewer.commit({
      kind: 'git.commit',
      projectId: id,
      worktree,
      revision: review.revision,
      message: 'fix: vat',
    });
    expect(done).toEqual({ ok: true });
    expect(git(linked, 'log', '-1', '--format=%s').trim()).toBe('fix: vat');
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('start');
  });

  it('refuses a worktree the repository does not list', async () => {
    expect(await reviewer.read(id, 'aaaaaaaaaaaa')).toEqual({
      ok: false,
      error: REVIEW_ERRORS.unknownWorktree,
    });
  });

  it('reads a repository with no commit yet', async () => {
    const empty = join(home, 'empty');
    await mkdir(empty);
    git(empty, 'init', '-q', '-b', 'main');
    writeFileSync(join(empty, 'first.ts'), 'a\n');
    store.upsertProject(project(empty));
    const outcome = await reviewer.read(projectIdFromPath(empty), null);
    expect(outcome.ok && outcome.review.files.map((f) => f.path)).toEqual(['first.ts']);
    expect(outcome.ok && outcome.review.base).toEqual({ ref: null, commit: null });
  });

  it('answers without a badge when gh fails, and keeps a badge for a minute', async () => {
    const gh = vi
      .fn<(dir: string, args: readonly string[]) => Promise<string>>()
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue(
        JSON.stringify({
          number: 7,
          title: 'T',
          url: 'https://github.example/acme/pull/7',
          state: 'MERGED',
        }),
      );
    let now = 1_000;
    const withGh = new GitReviewer({
      store,
      logger,
      parallel: async () => true,
      gh,
      now: () => now,
    });
    expect(await withGh.pullRequest(id, null)).toBeNull();
    now += 61_000;
    expect((await withGh.pullRequest(id, null))?.state).toBe('merged');
    now += 1_000;
    await withGh.pullRequest(id, null);
    expect(gh).toHaveBeenCalledTimes(2);
    // Read-only: only ever `pr view`.
    expect(gh.mock.calls.every(([, args]) => args[0] === 'pr' && args[1] === 'view')).toBe(true);
  });

  it('runs the scanner over a linked worktree, naming its main checkout', async () => {
    const linked = join(home, 'acme-shop-tax');
    git(repo, 'worktree', 'add', '-q', '-b', 'fix/tax', linked);
    store.upsertProject(project(linked));
    const scanner = new GitScanner({ store, logger, active: () => true, run: runGit });
    await scanner.scan(id);
    await scanner.scan(projectIdFromPath(linked));
    const parent = store.state.projects[id]?.git;
    expect(parent?.mainWorktree).toBeNull();
    expect(parent?.worktrees?.map((w) => w.branch)).toEqual(['main', 'fix/tax']);
    expect(store.state.projects[projectIdFromPath(linked)]?.git?.mainWorktree).toBe(repo);
  });
});
