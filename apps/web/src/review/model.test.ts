import type { GitReviewFile, GitWorktree } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import {
  fixSession,
  hunksFromPatch,
  isViewed,
  nextUnviewed,
  reviewTotals,
  toggleViewed,
} from './model.js';

const file = (path: string, extra: Partial<GitReviewFile> = {}): GitReviewFile => ({
  path,
  origPath: null,
  status: 'modified',
  added: 1,
  removed: 1,
  binary: false,
  patch: '',
  tooLarge: false,
  sig: `sig-${path}`,
  uncommitted: true,
  ...extra,
});

describe('hunksFromPatch', () => {
  it('numbers each block from its header', () => {
    const hunks = hunksFromPatch(
      '@@ -10,3 +10,3 @@ function total() {\n keep\n-old\n+new\n tail\n@@ -40 +40,2 @@\n last\n+added\n',
    );
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ['ctx', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['ctx', 12, 12],
    ]);
    expect(hunks[1]?.lines.at(-1)).toMatchObject({ type: 'add', newNo: 41 });
  });

  it('reads a new file, and skips the no-newline note', () => {
    const [hunk] = hunksFromPatch('@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n');
    expect(hunk?.added).toBe(2);
    expect(hunk?.lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('gives nothing for an empty patch', () => {
    expect(hunksFromPatch('')).toEqual([]);
  });
});

describe('viewed marks', () => {
  it('lapse when the file changes', () => {
    const marks = toggleViewed({}, file('a.ts'));
    expect(isViewed(marks, file('a.ts'))).toBe(true);
    expect(isViewed(marks, file('a.ts', { sig: 'newer' }))).toBe(false);
    expect(toggleViewed(marks, file('a.ts'))).toEqual({});
  });

  it('move to the next file left to read, wrapping round', () => {
    const files = [file('a.ts'), file('b.ts'), file('c.ts')];
    const marks = toggleViewed(toggleViewed({}, file('a.ts')), file('b.ts'));
    expect(nextUnviewed(files, marks, 'b.ts')).toBe('c.ts');
    expect(nextUnviewed(files, marks, 'c.ts')).toBeNull();
    expect(nextUnviewed(files, {}, 'c.ts')).toBe('a.ts');
  });
});

it('adds up the review', () => {
  expect(reviewTotals([file('a'), file('b', { added: 4, uncommitted: false })])).toEqual({
    added: 5,
    removed: 2,
    uncommitted: 1,
  });
});

describe('fixSession', () => {
  const session = (id: string, extra: object) => ({
    id,
    origin: 'board' as const,
    status: { kind: 'idle' } as never,
    cwd: '/home/dev/acme-shop',
    updatedAt: 1,
    ...extra,
  });
  const worktrees: GitWorktree[] = [
    { id: 'main', path: '/home/dev/acme-shop', branch: 'main', head: null, main: true },
    { id: 'tax', path: '/home/dev/acme-tax', branch: 'fix/tax', head: null, main: false },
  ];

  it('takes the latest board session in the reviewed folder', () => {
    const list = [
      session('old', { updatedAt: 1 }),
      session('new', { updatedAt: 2 }),
      session('there', { cwd: '/home/dev/acme-tax/src', updatedAt: 3 }),
      session('cli', { origin: 'terminal', updatedAt: 4 }),
      session('done', { status: { kind: 'ended' }, updatedAt: 5 }),
    ];
    expect(fixSession(list, worktrees, null)?.id).toBe('new');
    expect(fixSession(list, worktrees, 'tax')?.id).toBe('there');
    expect(fixSession([], worktrees, null)).toBeNull();
  });
});
