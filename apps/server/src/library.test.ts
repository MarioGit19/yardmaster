import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@c-board/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  diskLibraryFs,
  expandRoot,
  isInside,
  LIBRARY_MAX_ENTRIES,
  type LibraryFs,
  ProjectLibrary,
} from './library.js';

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'cboard-library-')));
  root = join(base, 'Desktop');
  outside = join(base, 'elsewhere');
  await mkdir(root);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function project(path: string, lastActivityAt: number | null, id = `p-${path.length}`): Project {
  return {
    id,
    path,
    name: path.split('/').at(-1) ?? 'x',
    accent: 0,
    source: 'editor',
    git: null,
    createdAt: 1_000,
    lastActivityAt,
  };
}

/** The disk, recording every call so a test can see exactly what was touched. */
function recordingFs(): { fs: LibraryFs; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fs: {
      realpath: (path) => {
        calls.push(`realpath ${path}`);
        return diskLibraryFs.realpath(path);
      },
      readdir: (path) => {
        calls.push(`readdir ${path}`);
        return diskLibraryFs.readdir(path);
      },
      stat: (path) => {
        calls.push(`stat ${path}`);
        return diskLibraryFs.stat(path);
      },
    },
  };
}

describe('ProjectLibrary.list', () => {
  it('lists top-level folders, marks git repos and ignores files and hidden folders', async () => {
    await mkdir(join(root, 'acme-shop', '.git'), { recursive: true });
    await mkdir(join(root, 'acme-shop', 'src', 'deep'), { recursive: true });
    await mkdir(join(root, 'field-notes'));
    await mkdir(join(root, '.cache'));
    await writeFile(join(root, 'todo.txt'), 'synthetic');
    await writeFile(join(root, '.DS_Store'), '');

    const library = new ProjectLibrary({ home: base });
    const result = await library.list([root], []);

    expect(result.roots).toEqual([{ root, count: 2, error: null, message: null }]);
    expect(result.entries.map((e) => [e.name, e.git])).toEqual([
      ['acme-shop', true],
      ['field-notes', false],
    ]);
    expect(result.entries[0]).toMatchObject({
      path: join(root, 'acme-shop'),
      root,
      projectId: null,
      lastActiveAt: null,
    });
  });

  it('treats a .git file (a worktree) as a repo too', async () => {
    await mkdir(join(root, 'worktree'));
    await writeFile(join(root, 'worktree', '.git'), 'gitdir: /home/dev/acme-shop/.git/worktrees/x');
    const result = await new ProjectLibrary().list([root], []);
    expect(result.entries[0]?.git).toBe(true);
  });

  it('reads nothing under a root except directory names and .git existence', async () => {
    await mkdir(join(root, 'acme-shop', '.git'), { recursive: true });
    await writeFile(join(root, 'acme-shop', 'package.json'), '{}');
    await mkdir(join(root, 'acme-shop', 'src'));
    await writeFile(join(root, 'notes.md'), 'synthetic');
    const { fs, calls } = recordingFs();

    await new ProjectLibrary({ fs }).list([root], []);

    expect(calls).toEqual([
      `realpath ${root}`,
      `stat ${root}`,
      `readdir ${root}`,
      `stat ${join(root, 'acme-shop', '.git')}`,
    ]);
  });

  it('expands ~ against the home directory', async () => {
    await mkdir(join(root, 'orbit-api'));
    const result = await new ProjectLibrary({ home: base }).list(['~/Desktop'], []);
    expect(result.roots[0]).toMatchObject({ root: '~/Desktop', count: 1, error: null });
    expect(result.entries[0]?.path).toBe(join(root, 'orbit-api'));
    expect(expandRoot('~', '/home/dev')).toBe('/home/dev');
    expect(expandRoot('/srv/code', '/home/dev')).toBe('/srv/code');
  });

  it('refuses a symlink that escapes the roots, and keeps one that stays inside', async () => {
    await mkdir(join(outside, 'secret-project'));
    await mkdir(join(root, 'real-one'));
    await symlink(join(outside, 'secret-project'), join(root, 'escape'));
    await symlink(join(root, 'real-one'), join(root, 'alias'));
    await symlink(join(base, 'missing'), join(root, 'dangling'));
    await symlink(join(outside), join(root, 'up'));

    const result = await new ProjectLibrary().list([root], []);

    expect(result.entries.map((e) => [e.name, e.path])).toEqual([
      ['real-one', join(root, 'real-one')],
    ]);
  });

  it('follows a symlinked root to its real folder', async () => {
    await mkdir(join(outside, 'ledger-sync'));
    await symlink(outside, join(base, 'linked-root'));
    const result = await new ProjectLibrary().list([join(base, 'linked-root')], []);
    expect(result.entries.map((e) => e.path)).toEqual([join(outside, 'ledger-sync')]);
  });

  it('merges recents from known projects: most recent first, then by name', async () => {
    for (const name of ['alpha', 'bravo', 'charlie', 'delta']) await mkdir(join(root, name));
    const projects = [
      project(join(root, 'charlie'), 5_000, 'p-charlie'),
      project(join(root, 'delta'), 9_000, 'p-delta'),
      project(join(outside, 'zulu'), 99_000, 'p-zulu'),
    ];

    const result = await new ProjectLibrary().list([root], projects);

    expect(result.entries.map((e) => [e.name, e.projectId, e.lastActiveAt])).toEqual([
      ['delta', 'p-delta', 9_000],
      ['charlie', 'p-charlie', 5_000],
      ['alpha', null, null],
      ['bravo', null, null],
    ]);
  });

  it('lists a folder once when two roots overlap', async () => {
    await mkdir(join(root, 'docs-site'));
    const result = await new ProjectLibrary().list([root, `${root}/`], []);
    expect(result.entries).toHaveLength(1);
    expect(result.roots.map((r) => r.count)).toEqual([1, 0]);
  });

  it('reports a missing root and a file root without failing the others', async () => {
    await mkdir(join(root, 'pixel-studio'));
    await writeFile(join(base, 'a-file'), '');
    const result = await new ProjectLibrary().list(
      [join(base, 'nope'), join(base, 'a-file'), root],
      [],
    );
    expect(result.roots.map((r) => r.error)).toEqual(['missing', 'not_directory', null]);
    expect(result.entries.map((e) => e.name)).toEqual(['pixel-studio']);
  });

  it('explains a macOS permission error (EPERM) on the root', async () => {
    const eperm = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const fs: LibraryFs = {
      ...diskLibraryFs,
      readdir: async () => {
        throw eperm;
      },
    };
    const result = await new ProjectLibrary({ fs }).list([root], []);
    expect(result.entries).toEqual([]);
    expect(result.roots[0]).toMatchObject({ root, count: 0, error: 'permission' });
    expect(result.roots[0]?.message).toContain(
      'System Settings → Privacy & Security → Files and Folders',
    );
  });

  it('caps the folders listed per root', async () => {
    await Promise.all(
      Array.from({ length: LIBRARY_MAX_ENTRIES + 5 }, (_, i) =>
        mkdir(join(root, `p${String(i).padStart(4, '0')}`)),
      ),
    );
    const result = await new ProjectLibrary().list([root], []);
    expect(result.entries).toHaveLength(LIBRARY_MAX_ENTRIES);
  });
});

describe('ProjectLibrary.resolve', () => {
  it('accepts a folder inside a root and refuses paths outside the roots', async () => {
    await mkdir(join(root, 'acme-shop', 'src'), { recursive: true });
    await mkdir(join(root, '.hidden'));
    await mkdir(join(outside, 'secret-project'));
    await writeFile(join(root, 'notes.md'), '');
    await symlink(join(outside, 'secret-project'), join(root, 'escape'));
    const library = new ProjectLibrary();
    const roots = [root];

    expect(await library.resolve(roots, join(root, 'acme-shop'))).toBe(join(root, 'acme-shop'));
    expect(await library.resolve(roots, join(outside, 'secret-project'))).toBeNull();
    expect(
      await library.resolve(roots, join(root, '..', 'elsewhere', 'secret-project')),
    ).toBeNull();
    expect(await library.resolve(roots, join(root, 'escape'))).toBeNull();
    expect(await library.resolve(roots, join(root, '.hidden'))).toBeNull();
    expect(await library.resolve(roots, join(root, 'notes.md'))).toBeNull();
    expect(await library.resolve(roots, join(root, 'missing'))).toBeNull();
    expect(await library.resolve(roots, root)).toBeNull();
    expect(await library.resolve(roots, 'Desktop/acme-shop')).toBeNull();
    expect(await library.resolve([], join(root, 'acme-shop'))).toBeNull();
  });

  it('isInside is strict', () => {
    expect(isInside('/home/dev', '/home/dev/acme-shop')).toBe(true);
    expect(isInside('/home/dev', '/home/dev')).toBe(false);
    expect(isInside('/home/dev', '/home/devious')).toBe(false);
    expect(isInside('/home/dev', '/home')).toBe(false);
  });
});
