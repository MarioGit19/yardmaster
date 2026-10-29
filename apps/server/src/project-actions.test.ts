import {
  type EditorWindow,
  type Project,
  type ProjectSource,
  projectIdFromPath,
  type UiAction,
} from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import type { ActionResult } from './actions.js';
import { closeProjectWindows } from './editor-actions.js';
import { EDITOR_NOT_FOUND, EditorLauncher, type Spawner } from './editor-cli.js';
import { EditorRouter, ROUTE_ERRORS } from './editor-router.js';
import type { LibrarySource } from './library.js';
import {
  createCloseActions,
  createLaunchActions,
  createProjectActions,
  OUTSIDE_LIBRARY,
  WINDOW_NOT_CLOSED,
} from './project-actions.js';
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

/** Never launches anything: it records what the editor CLI would have been run with. */
function fakeLauncher(executables = ['/usr/local/bin/cursor']) {
  const spawned: [string, string[]][] = [];
  const spawn: Spawner = async (file, args) => {
    spawned.push([file, args]);
    return { ok: true };
  };
  const launcher = new EditorLauncher({
    configured: () => null,
    deps: {
      env: { PATH: '/usr/local/bin' },
      platform: 'linux',
      home: ROOT,
      isExecutable: async (path) => executables.includes(path),
    },
    spawn,
  });
  return { launcher, spawned };
}

function setup(roots: string[] = ['~/Desktop'], executables?: string[]) {
  const store = new BoardStore({ autoFlush: false });
  const { launcher, spawned } = fakeLauncher(executables);
  const actions = createProjectActions({
    store,
    library,
    roots: () => roots,
    now: () => T0,
    launcher,
  });
  return {
    store,
    spawned,
    add: (path: string) => actions['project.add']({ kind: 'project.add', path }),
    open: (projectId: string) =>
      actions['project.openInEditor']({ kind: 'project.openInEditor', projectId }),
  };
}

function project(path: string, source: ProjectSource = 'manual'): Project {
  return {
    id: projectIdFromPath(path),
    path,
    name: path.split('/').pop() ?? path,
    accent: 0,
    source,
    git: null,
    createdAt: T0 - 1_000,
    lastActivityAt: T0 - 1_000,
  };
}

function window(id: string, projectIds: string[]): EditorWindow {
  return {
    id,
    appName: 'Cursor',
    appVersion: '1.93.0',
    extensionVersion: '0.1.0',
    workspaceFolders: [],
    projectIds,
    capabilities: { shellExecution: true },
    connectedAt: T0,
    lastSeenAt: T0,
  };
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

describe('project.openInEditor', () => {
  it('runs the editor CLI on a library project, the folder as its only argument', async () => {
    const { store, spawned, open } = setup();
    const recipes = project('/home/dev/recipe-box');
    store.upsertProject(recipes);
    expect(await open(recipes.id)).toEqual({ ok: true, editor: 'Cursor' });
    expect(spawned).toEqual([['/usr/local/bin/cursor', ['/home/dev/recipe-box']]]);
    expect(store.state.projects[recipes.id]?.lastActivityAt).toBeGreaterThan(T0 - 1_000);
  });

  it('opens the realpath that passed the library check, not the stored path', async () => {
    const store = new BoardStore({ autoFlush: false });
    const { launcher, spawned } = fakeLauncher();
    const actions = createProjectActions({
      store,
      library: {
        ...library,
        resolve: async (_roots, path) =>
          path === '/home/dev/link' ? '/home/dev/recipe-box' : null,
      },
      roots: () => ['~/Desktop'],
      launcher,
    });
    const linked = project('/home/dev/link');
    store.upsertProject(linked);
    const result = await actions['project.openInEditor']({
      kind: 'project.openInEditor',
      projectId: linked.id,
    });
    expect(result).toEqual({ ok: true, editor: 'Cursor' });
    expect(spawned).toEqual([['/usr/local/bin/cursor', ['/home/dev/recipe-box']]]);
  });

  it('falls back to code when cursor is not installed', async () => {
    const { store, spawned, open } = setup(['~/Desktop'], ['/usr/local/bin/code']);
    const recipes = project('/home/dev/recipe-box');
    store.upsertProject(recipes);
    expect(await open(recipes.id)).toEqual({ ok: true, editor: 'VS Code' });
    expect(spawned).toEqual([['/usr/local/bin/code', ['/home/dev/recipe-box']]]);
  });

  it('refuses a project outside the library roots, whatever its source', async () => {
    const { store, spawned, open } = setup();
    for (const p of [project('/etc', 'manual'), project('/srv/acme/api', 'editor')]) {
      store.upsertProject(p);
      expect(await open(p.id)).toEqual({ ok: false, error: OUTSIDE_LIBRARY });
    }
    expect(spawned).toEqual([]);
  });

  it('refuses everything while no root is configured', async () => {
    const { store, spawned, open } = setup([]);
    const recipes = project('/home/dev/recipe-box');
    store.upsertProject(recipes);
    expect(await open(recipes.id)).toEqual({ ok: false, error: OUTSIDE_LIBRARY });
    expect(spawned).toEqual([]);
  });

  it('reports an unknown project and a missing editor CLI', async () => {
    const { store, open } = setup(['~/Desktop'], []);
    expect(await open('nope')).toEqual({ ok: false, error: ROUTE_ERRORS.unknownProject });
    const recipes = project('/home/dev/recipe-box');
    store.upsertProject(recipes);
    expect(await open(recipes.id)).toEqual({ ok: false, error: EDITOR_NOT_FOUND });
  });
});

describe('launch routing', () => {
  function launchSetup(options: { roots?: string[]; board?: boolean; offline?: string[] } = {}) {
    const store = new BoardStore({ autoFlush: false });
    const roots = options.roots ?? ['~/Desktop'];
    const calls: string[] = [];
    const record =
      (name: string) =>
      (action: UiAction): ActionResult => {
        calls.push(`${name}:${action.kind}`);
        return { ok: true };
      };
    const actions = createLaunchActions({
      store,
      library,
      roots: () => roots,
      router: new EditorRouter({
        state: () => store.state,
        isConnected: (id) => !(options.offline ?? []).includes(id),
      }),
      editorTerminal: record('editor'),
      ...(options.board === false ? {} : { boardTerminal: record('board') }),
      sessionCreate: record('runner'),
    });
    return {
      store,
      calls,
      terminal: (projectId: string) =>
        actions['terminal.create']({ kind: 'terminal.create', projectId, command: 'pnpm dev' }),
      session: (projectId: string) =>
        actions['session.create']({ kind: 'session.create', projectId, prompt: 'Fix the build' }),
    };
  }

  it('sends terminal.create to the connected editor window, wherever the project is', async () => {
    const { store, calls, terminal } = launchSetup({ roots: [] });
    const api = project('/srv/acme/api', 'editor');
    store.upsertProject(api);
    store.upsertWindow(window('w1', [api.id]));
    expect(await terminal(api.id)).toEqual({ ok: true });
    expect(calls).toEqual(['editor:terminal.create']);
  });

  it('opens a board terminal in a library project no editor window has open', async () => {
    const { store, calls, terminal } = launchSetup();
    const recipes = project('/home/dev/recipe-box');
    store.upsertProject(recipes);
    expect(await terminal(recipes.id)).toEqual({ ok: true });
    expect(calls).toEqual(['board:terminal.create']);
  });

  it('falls back to a board terminal when the window is offline', async () => {
    const { store, calls, terminal } = launchSetup({ offline: ['w1'] });
    const recipes = project('/home/dev/recipe-box', 'editor');
    store.upsertProject(recipes);
    store.upsertWindow(window('w1', [recipes.id]));
    expect(await terminal(recipes.id)).toEqual({ ok: true });
    expect(calls).toEqual(['board:terminal.create']);
  });

  it('refuses a board terminal outside the library roots', async () => {
    const { store, calls, terminal } = launchSetup();
    const api = project('/srv/acme/api', 'editor');
    store.upsertProject(api);
    expect(await terminal(api.id)).toEqual({ ok: false, error: OUTSIDE_LIBRARY });
    expect(calls).toEqual([]);
  });

  it('keeps the editor error until board terminals exist', async () => {
    const { store, calls, terminal } = launchSetup({ board: false, offline: ['w1'] });
    const recipes = project('/home/dev/recipe-box');
    store.upsertProject(recipes);
    expect(await terminal(recipes.id)).toEqual({ ok: false, error: ROUTE_ERRORS.noEditor });
    store.upsertWindow(window('w1', [recipes.id]));
    expect(await terminal(recipes.id)).toEqual({ ok: false, error: ROUTE_ERRORS.editorOffline });
    expect(await terminal('nope')).toEqual({ ok: false, error: ROUTE_ERRORS.unknownProject });
    expect(calls).toEqual([]);
  });

  it('starts a session in a library project', async () => {
    const { store, calls, session } = launchSetup();
    const recipes = project('/home/dev/recipe-box');
    store.upsertProject(recipes);
    expect(await session(recipes.id)).toEqual({ ok: true });
    expect(calls).toEqual(['runner:session.create']);
  });

  it('refuses a session in a library project whose folder left the roots', async () => {
    const { store, calls, session } = launchSetup({ roots: [] });
    const recipes = project('/home/dev/recipe-box');
    store.upsertProject(recipes);
    expect(await session(recipes.id)).toEqual({ ok: false, error: OUTSIDE_LIBRARY });
    expect(calls).toEqual([]);
  });

  it('starts sessions in projects an editor or Claude reported, as before', async () => {
    const { store, calls, session } = launchSetup({ roots: [] });
    const api = project('/srv/acme/api', 'editor');
    const tools = project('/srv/acme/tools', 'hook');
    store.upsertProject(api);
    store.upsertProject(tools);
    expect(await session(api.id)).toEqual({ ok: true });
    expect(await session(tools.id)).toEqual({ ok: true });
    expect(calls).toEqual(['runner:session.create', 'runner:session.create']);
  });
});

function closeSetup(windowResult: ActionResult = { ok: true }) {
  const store = new BoardStore({ autoFlush: false, now: () => T0 + 10_000 });
  const calls: string[] = [];
  const actions = createCloseActions({
    store,
    stopTerminals: (id) => calls.push(`stop:${id}`),
    suspendSessions: async (id) => {
      calls.push(`suspend:${id}`);
    },
    closeWindows: async (id) => {
      calls.push(`window:${id}`);
      return windowResult;
    },
    unpin: (id) => calls.push(`unpin:${id}`),
    now: () => T0 + 5_000,
  });
  const shop = project('/home/dev/acme-shop', 'editor');
  store.upsertProject(shop);
  return {
    store,
    calls,
    shop,
    close: (projectId: string, closeWindow?: boolean) =>
      actions['project.close']({
        kind: 'project.close',
        projectId,
        ...(closeWindow !== undefined ? { closeWindow } : {}),
      }),
    forget: (projectId: string) => actions['project.forget']({ kind: 'project.forget', projectId }),
  };
}

describe('project.close', () => {
  it('stops what the board owns, unpins and marks the project closed', async () => {
    const { store, calls, shop, close } = closeSetup();
    expect(await close(shop.id)).toEqual({ ok: true });
    expect(calls).toEqual([`stop:${shop.id}`, `suspend:${shop.id}`, `unpin:${shop.id}`]);
    expect(store.state.projects[shop.id]?.closedAt).toBe(T0 + 5_000);
  });

  it('closes the editor windows only when asked', async () => {
    const { calls, shop, close } = closeSetup();
    await close(shop.id, false);
    expect(calls).not.toContain(`window:${shop.id}`);
    await close(shop.id, true);
    expect(calls).toContain(`window:${shop.id}`);
  });

  it('still closes the project when a window would not close, and says so', async () => {
    const { store, shop, close } = closeSetup({ ok: false, error: 'editor_offline' });
    expect(await close(shop.id, true)).toEqual({ ok: false, error: WINDOW_NOT_CLOSED });
    expect(store.state.projects[shop.id]?.closedAt).toBe(T0 + 5_000);
  });

  it('refuses an unknown project and touches nothing', async () => {
    const { calls, close } = closeSetup();
    expect(await close('ffffffffffff')).toEqual({
      ok: false,
      error: ROUTE_ERRORS.unknownProject,
    });
    expect(calls).toEqual([]);
  });

  it('comes back when a new terminal opens there, not for older ones', async () => {
    const { store, shop, close } = closeSetup();
    store.upsertWindow(window('w1', [shop.id]));
    store.upsertTerminal({
      id: 't-old',
      windowId: 'w1',
      name: 'zsh',
      projectId: shop.id,
      createdAt: T0,
    });
    await close(shop.id);
    // The editor re-reporting what it already had changes nothing.
    store.upsertTerminal({ id: 't-old', windowId: 'w1', name: 'zsh', active: true });
    store.upsertWindow({ ...window('w1', [shop.id]), lastSeenAt: T0 + 6_000 });
    expect(store.state.projects[shop.id]?.closedAt).toBe(T0 + 5_000);
    store.upsertTerminal({ id: 't-new', windowId: 'w1', name: 'zsh', projectId: shop.id });
    expect(store.state.projects[shop.id]?.closedAt).toBeNull();
  });

  it('comes back for a new Claude session or editor window', async () => {
    const { store, shop, close } = closeSetup();
    await close(shop.id);
    store.upsertSession({ id: 's-new', projectId: shop.id, startedAt: T0 + 7_000 });
    expect(store.state.projects[shop.id]?.closedAt).toBeNull();

    await close(shop.id);
    store.upsertWindow({ ...window('w2', [shop.id]), connectedAt: T0 + 8_000 });
    expect(store.state.projects[shop.id]?.closedAt).toBeNull();
  });

  it('comes back when the picker opens it again', async () => {
    const { store, close } = closeSetup();
    const recipes = project('/home/dev/recipe-box');
    store.upsertProject(recipes);
    await close(recipes.id);
    const actions = createProjectActions({
      store,
      library,
      roots: () => ['~/Desktop'],
      launcher: fakeLauncher().launcher,
    });
    await actions['project.add']({ kind: 'project.add', path: recipes.path });
    expect(store.state.projects[recipes.id]?.closedAt).toBeNull();
  });
});

describe('project.forget', () => {
  it('closes the project, then drops it from the board', async () => {
    const { store, calls, shop, forget } = closeSetup();
    expect(await forget(shop.id)).toEqual({ ok: true });
    expect(calls).toEqual([`stop:${shop.id}`, `suspend:${shop.id}`, `unpin:${shop.id}`]);
    expect(store.state.projects[shop.id]).toBeUndefined();
  });

  it('refuses an unknown project', async () => {
    const { forget } = closeSetup();
    expect(await forget('ffffffffffff')).toEqual({
      ok: false,
      error: ROUTE_ERRORS.unknownProject,
    });
  });
});

describe('closeProjectWindows', () => {
  it('sends cmd.closeWindow to each window open on the project', async () => {
    const sent: [string, string][] = [];
    const windows = {
      w1: window('w1', ['p-shop']),
      w2: window('w2', ['p-blog']),
      w3: window('w3', ['p-blog', 'p-shop']),
    };
    const close = closeProjectWindows({
      state: () => ({ windows }),
      send: async (windowId, type) => {
        sent.push([windowId, type]);
        return windowId === 'w3' ? { ok: false, error: 'editor_offline' } : { ok: true };
      },
    });
    expect(await close('p-blog')).toEqual({ ok: false, error: 'editor_offline' });
    expect(sent).toEqual([
      ['w2', 'cmd.closeWindow'],
      ['w3', 'cmd.closeWindow'],
    ]);
    expect(await close('p-none')).toEqual({ ok: true });
  });
});
