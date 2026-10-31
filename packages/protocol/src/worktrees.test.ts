import { describe, expect, it } from 'vitest';
import type { GitInfo, GitWorktree } from './domain.js';
import { projectIdFromPath } from './project.js';
import {
  groupWorktrees,
  sessionWorktree,
  worktreeContaining,
  worktreeParent,
} from './worktrees.js';

const MAIN = '/home/dev/acme-shop';
const LINKED = '/home/dev/acme-shop-tax';

const worktree = (path: string, main: boolean): GitWorktree => ({
  id: projectIdFromPath(path),
  path,
  branch: main ? 'main' : 'fix/tax',
  head: null,
  main,
});

const git = (mainWorktree: string | null) => ({ mainWorktree }) as GitInfo;

const project = (path: string, info: GitInfo | null = null) => ({
  id: projectIdFromPath(path),
  git: info,
});

describe('worktreeContaining', () => {
  const list = [worktree(MAIN, true), worktree(`${MAIN}/.claude/worktrees/tax`, false)];

  it('takes the deepest and respects folder boundaries', () => {
    expect(worktreeContaining(list, `${MAIN}/.claude/worktrees/tax/src`)?.main).toBe(false);
    expect(worktreeContaining(list, `${MAIN}/src`)?.main).toBe(true);
    expect(worktreeContaining(list, `${MAIN}-other`)).toBeNull();
  });
});

describe('sessionWorktree', () => {
  const info = { worktrees: [worktree(MAIN, true), worktree(LINKED, false)] };

  it('finds a linked worktree by cwd or by statusline, never the main one', () => {
    expect(sessionWorktree({ cwd: `${LINKED}/src` }, info)?.branch).toBe('fix/tax');
    expect(
      sessionWorktree(
        {
          cwd: MAIN,
          meter: {
            costUsd: null,
            contextPercent: null,
            contextSize: null,
            worktree: {
              name: 'tax',
              path: LINKED,
              branch: 'fix/tax',
              originalCwd: MAIN,
              originalBranch: 'main',
            },
          },
        },
        info,
      )?.path,
    ).toBe(LINKED);
    expect(sessionWorktree({ cwd: MAIN }, info)).toBeNull();
    expect(sessionWorktree({ cwd: null }, info)).toBeNull();
    expect(sessionWorktree({ cwd: LINKED }, null)).toBeNull();
  });
});

describe('groupWorktrees', () => {
  it('puts a worktree right behind its main checkout', () => {
    const parent = project(MAIN);
    const other = project('/home/dev/orbit-api');
    const child = project(LINKED, git(MAIN));
    expect(groupWorktrees([child, other, parent])).toEqual([other, parent, child]);
    expect(worktreeParent(child, { [parent.id]: parent, [child.id]: child })).toBe(parent);
  });

  it('leaves a worktree in place while its main checkout is not on the board', () => {
    const other = project('/home/dev/orbit-api');
    const child = project(LINKED, git(MAIN));
    expect(groupWorktrees([child, other])).toEqual([child, other]);
  });
});
