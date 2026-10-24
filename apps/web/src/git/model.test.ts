import type { GitFileChange } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { groupFiles, splitPath, syncState, unlistedCount } from './model.js';

const file = (path: string, status: GitFileChange['status']): GitFileChange => ({
  path,
  origPath: null,
  status,
  staged: false,
  unstaged: true,
});

describe('groupFiles', () => {
  it('groups by status in display order with sorted paths', () => {
    const groups = groupFiles([
      file('z.ts', 'modified'),
      file('notes.md', 'untracked'),
      file('a.ts', 'modified'),
      file('merge.ts', 'conflicted'),
    ]);
    expect(groups.map((g) => [g.label, g.files.map((f) => f.path)])).toEqual([
      ['Conflicts', ['merge.ts']],
      ['Modified', ['a.ts', 'z.ts']],
      ['Untracked', ['notes.md']],
    ]);
  });

  it('returns nothing for a clean tree', () => {
    expect(groupFiles([])).toEqual([]);
  });
});

describe('splitPath', () => {
  it('splits the directory from the file name', () => {
    expect(splitPath('src/lib/cart.ts')).toEqual({ dir: 'src/lib/', name: 'cart.ts' });
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' });
    expect(splitPath('vendor/pkg/')).toEqual({ dir: 'vendor/', name: 'pkg' });
  });
});

describe('syncState', () => {
  it('tells apart no upstream, in sync and diverged', () => {
    expect(syncState({ upstream: null, ahead: 0, behind: 0 })).toEqual({ kind: 'none' });
    expect(syncState({ upstream: 'origin/main', ahead: 0, behind: 0 })).toEqual({
      kind: 'synced',
    });
    expect(syncState({ upstream: 'origin/main', ahead: 2, behind: 1 })).toEqual({
      kind: 'diverged',
      ahead: 2,
      behind: 1,
    });
  });
});

describe('unlistedCount', () => {
  it('counts changes beyond the listed files', () => {
    expect(unlistedCount({ dirty: 205, files: Array(200).fill(file('a', 'added')) })).toBe(5);
    expect(unlistedCount({ dirty: 1, files: [file('a', 'added')] })).toBe(0);
  });
});
