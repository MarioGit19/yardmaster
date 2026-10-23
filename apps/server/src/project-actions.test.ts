import { projectIdFromPath } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import type { LibrarySource } from './library.js';
import { createProjectActions, OUTSIDE_LIBRARY } from './project-actions.js';
import { BoardStore } from './store.js';

const T0 = 1_760_000_000_000;
const ROOT = '/home/dev';

/** Resolves only folders directly inside `ROOT`, and only once a root is configured. */
const library: LibrarySource = {
  list: async () => ({ roots: [], entries: [] }),
  resolve: async (roots, path) =>
    roots.length > 0 && path.startsWith(`${ROOT}/`) && !path.slice(ROOT.length + 1).includes('/')
      ? path
      : null,
};

function setup(roots: string[] = ['~/Desktop']) {
  const store = new BoardStore({ autoFlush: false });
  const add = createProjectActions({ store, library, roots: () => roots, now: () => T0 })[
    'project.add'
  ];
  return { store, add: (path: string) => add({ kind: 'project.add', path }) };
}

describe('project.add', () => {
  it('puts a library folder on the board as a manual project', async () => {
    const { store, add } = setup();
    expect(await add('/home/dev/recipe-box')).toEqual({ ok: true });
    const id = projectIdFromPath('/home/dev/recipe-box');
    expect(store.state.projects[id]).toMatchObject({
      id,
      path: '/home/dev/recipe-box',
      name: 'recipe-box',
      source: 'manual',
      git: null,
      createdAt: T0,
      lastActivityAt: T0,
    });
  });

  it('refuses a path the library does not resolve', async () => {
    const { store, add } = setup();
    expect(await add('/etc')).toEqual({ ok: false, error: OUTSIDE_LIBRARY });
    expect(await add('/home/dev/recipe-box/src')).toEqual({ ok: false, error: OUTSIDE_LIBRARY });
    expect(Object.keys(store.state.projects)).toEqual([]);
  });

  it('refuses everything while no root is configured', async () => {
    const { add } = setup([]);
    expect(await add('/home/dev/recipe-box')).toEqual({ ok: false, error: OUTSIDE_LIBRARY });
  });

  it('leaves a project already on the board as it is, only touching it', async () => {
    const { store, add } = setup();
    const id = projectIdFromPath('/home/dev/acme-shop');
    store.upsertProject({
      id,
      path: '/home/dev/acme-shop',
      name: 'acme-shop',
      accent: 3,
      source: 'editor',
      git: null,
      createdAt: T0 - 1_000,
      lastActivityAt: T0 - 1_000,
    });
    expect(await add('/home/dev/acme-shop')).toEqual({ ok: true });
    expect(store.state.projects[id]).toMatchObject({ source: 'editor', accent: 3 });
  });
});
