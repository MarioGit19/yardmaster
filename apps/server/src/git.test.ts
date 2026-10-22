import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_MAX_COMMITS, GIT_MAX_FILES, GitInfo } from '@c-board/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { GIT_LOG_ARGS, GIT_STATUS_ARGS, parseGitLog, parseGitStatus, sameGitInfo } from './git.js';
import { runGit } from './git-scanner.js';

// Synthetic porcelain v2 output, as `git status --porcelain=v2 --branch -z` prints it.
const OID = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';
const H1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const H2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const z = (...records: string[]) => `${records.join('\0')}\0`;
const ordinary = (xy: string, path: string) =>
  `1 ${xy} N... 100644 100644 100644 ${H1} ${H2} ${path}`;

describe('parseGitStatus', () => {
  it('reads branch, upstream and ahead/behind', () => {
    const status = parseGitStatus(
      z(
        `# branch.oid ${OID}`,
        '# branch.head feat/checkout',
        '# branch.upstream origin/feat/checkout',
        '# branch.ab +3 -1',
      ),
    );
    expect(status).toEqual({
      branch: 'feat/checkout',
      head: OID,
      detached: false,
      upstream: 'origin/feat/checkout',
      ahead: 3,
      behind: 1,
      dirty: 0,
      files: [],
    });
  });

  it('handles a branch without upstream', () => {
    const status = parseGitStatus(z(`# branch.oid ${OID}`, '# branch.head main'));
    expect(status).toMatchObject({ branch: 'main', upstream: null, ahead: 0, behind: 0 });
  });

  it('handles a detached HEAD', () => {
    const status = parseGitStatus(z(`# branch.oid ${OID}`, '# branch.head (detached)'));
    expect(status).toMatchObject({ branch: null, head: OID, detached: true });
  });

  it('handles a repository without commits', () => {
    const status = parseGitStatus(z('# branch.oid (initial)', '# branch.head main', '? README.md'));
    expect(status).toMatchObject({ branch: 'main', head: null, dirty: 1 });
  });

  it('classifies ordinary changes and staging', () => {
    const { files, dirty } = parseGitStatus(
      z(
        ordinary('M.', 'src/staged.ts'),
        ordinary('.M', 'src/unstaged.ts'),
        ordinary('MM', 'src/both.ts'),
        ordinary('A.', 'src/new.ts'),
        ordinary('AM', 'src/new-edited.ts'),
        ordinary('.D', 'src/gone.ts'),
        ordinary('D.', 'src/removed.ts'),
        ordinary('.T', 'bin/link'),
      ),
    );
    expect(dirty).toBe(8);
    expect(files.map((f) => [f.path, f.status, f.staged, f.unstaged])).toEqual([
      ['src/staged.ts', 'modified', true, false],
      ['src/unstaged.ts', 'modified', false, true],
      ['src/both.ts', 'modified', true, true],
      ['src/new.ts', 'added', true, false],
      ['src/new-edited.ts', 'added', true, true],
      ['src/gone.ts', 'deleted', false, true],
      ['src/removed.ts', 'deleted', true, false],
      ['bin/link', 'typechange', false, true],
    ]);
  });

  it('reads renames and copies with their source path', () => {
    const { files } = parseGitStatus(
      z(
        `2 R. N... 100644 100644 100644 ${H1} ${H1} R100 src/pay.ts`,
        'src/payment.ts',
        `2 C. N... 100644 100644 100644 ${H1} ${H1} C75 src/copy.ts`,
        'src/original.ts',
        ordinary('.M', 'after.ts'),
      ),
    );
    expect(files).toEqual([
      {
        path: 'src/pay.ts',
        origPath: 'src/payment.ts',
        status: 'renamed',
        staged: true,
        unstaged: false,
      },
      {
        path: 'src/copy.ts',
        origPath: 'src/original.ts',
        status: 'copied',
        staged: true,
        unstaged: false,
      },
      { path: 'after.ts', origPath: null, status: 'modified', staged: false, unstaged: true },
    ]);
  });

  it('reads conflicts and untracked files, and ignores ignored ones', () => {
    const { files, dirty } = parseGitStatus(
      z(
        `u UU N... 100644 100644 100644 100644 ${H1} ${H2} ${H1} src/merge.ts`,
        '? notes/todo list.md',
        '! dist/',
      ),
    );
    expect(dirty).toBe(2);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/merge.ts', 'conflicted'],
      ['notes/todo list.md', 'untracked'],
    ]);
  });

  it('keeps spaces and odd characters in paths', () => {
    const { files } = parseGitStatus(z(ordinary('.M', 'docs/a b  c/"quoted" ünï.md')));
    expect(files[0]?.path).toBe('docs/a b  c/"quoted" ünï.md');
  });

  it('skips malformed records', () => {
    const status = parseGitStatus(
      z('1 M.', '1 MXY N... 1 1 1 a b c', '? ', 'garbage', '# branch.ab nope', '#'),
    );
    expect(status).toMatchObject({ dirty: 0, files: [], ahead: 0, behind: 0 });
  });

  it('caps the file list but counts everything', () => {
    const records = Array.from({ length: GIT_MAX_FILES + 25 }, (_, i) => `? file-${i}.txt`);
    const { files, dirty } = parseGitStatus(z(...records));
    expect(files).toHaveLength(GIT_MAX_FILES);
    expect(dirty).toBe(GIT_MAX_FILES + 25);
  });

  it('handles empty output', () => {
    expect(parseGitStatus('')).toMatchObject({ branch: null, head: null, dirty: 0 });
  });
});

describe('parseGitLog', () => {
  const US = '\x1f';
  const commit = (hash: string, author: string, at: number, subject: string) =>
    [hash, author, String(at), subject].join(US);

  it('reads commits newest first', () => {
    const out = z(
      commit(H1, 'Dev One', 1_760_000_100, 'Add cart totals'),
      commit(H2, 'Dev Two', 1_760_000_000, 'Initial commit'),
    );
    expect(parseGitLog(out)).toEqual([
      { hash: H1, author: 'Dev One', at: 1_760_000_100_000, subject: 'Add cart totals' },
      { hash: H2, author: 'Dev Two', at: 1_760_000_000_000, subject: 'Initial commit' },
    ]);
  });

  it('keeps empty subjects and separators inside the subject', () => {
    const out = z(commit(H1, 'Dev One', 1, ''), commit(H2, 'Dev One', 2, `a${US}b`));
    expect(parseGitLog(out).map((c) => c.subject)).toEqual(['', `a${US}b`]);
  });

  it('skips malformed records and caps the count', () => {
    const good = Array.from({ length: GIT_MAX_COMMITS + 2 }, (_, i) =>
      commit(H1, 'Dev One', i, `c${i}`),
    );
    const out = z('not-a-hash\x1fx\x1f1\x1fs', commit(H1, 'Dev One', -1, 'neg'), ...good);
    const commits = parseGitLog(out);
    expect(commits).toHaveLength(GIT_MAX_COMMITS);
    expect(commits[0]?.subject).toBe('c0');
  });
});

describe('sameGitInfo', () => {
  const info = GitInfo.parse({
    branch: 'main',
    head: OID,
    detached: false,
    dirty: 1,
    ahead: 0,
    behind: 0,
    files: [{ path: 'a.ts', origPath: null, status: 'modified', staged: false, unstaged: true }],
    updatedAt: 1,
  });

  it('ignores updatedAt', () => {
    expect(sameGitInfo(info, { ...info, updatedAt: 2 })).toBe(true);
  });

  it('notices changed files and commits', () => {
    expect(sameGitInfo(info, { ...info, files: [] })).toBe(false);
    expect(
      sameGitInfo(info, {
        ...info,
        files: [{ path: 'a.ts', origPath: null, status: 'modified', staged: true, unstaged: true }],
      }),
    ).toBe(false);
    expect(
      sameGitInfo(info, { ...info, commits: [{ hash: H1, author: 'x', at: 1, subject: 's' }] }),
    ).toBe(false);
    expect(sameGitInfo(info, null)).toBe(false);
    expect(sameGitInfo(null, null)).toBe(true);
  });
});

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('git output against a real repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c-board-git-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Dev One',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'Dev One',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('parses status and log', async () => {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    writeFileSync(join(dir, 'b c.txt'), 'two\n');
    git('add', '.');
    git('commit', '-q', '--no-gpg-sign', '-m', 'First');
    git('commit', '-q', '--no-gpg-sign', '--allow-empty', '-m', 'Second');
    git('mv', 'b c.txt', 'renamed.txt');
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    writeFileSync(join(dir, 'new file.md'), 'x\n');

    const status = parseGitStatus(await runGit(dir, GIT_STATUS_ARGS));
    expect(status).toMatchObject({ branch: 'main', detached: false, upstream: null, dirty: 3 });
    expect(status.head).toMatch(/^[0-9a-f]{40}$/);
    expect(status.files).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', origPath: null, status: 'modified', staged: false, unstaged: true },
        {
          path: 'renamed.txt',
          origPath: 'b c.txt',
          status: 'renamed',
          staged: true,
          unstaged: false,
        },
        { path: 'new file.md', origPath: null, status: 'untracked', staged: false, unstaged: true },
      ]),
    );

    const commits = parseGitLog(await runGit(dir, GIT_LOG_ARGS));
    expect(commits.map((c) => [c.subject, c.author])).toEqual([
      ['Second', 'Dev One'],
      ['First', 'Dev One'],
    ]);
    expect(commits[0]?.hash).toBe(status.head);
  });

  it('reports a folder outside git', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'c-board-plain-'));
    try {
      await expect(runGit(plain, GIT_STATUS_ARGS)).rejects.toMatchObject({
        stderr: expect.stringMatching(/not a git repository/i),
      });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
