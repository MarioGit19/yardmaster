import { basename } from 'node:path';
import { accentIndexForProject, type Project, projectIdFromPath } from '@yardmaster/protocol';
import type { ActionHandler, ActionHandlers, ActionResult } from './actions.js';
import type { EditorLauncher } from './editor-cli.js';
import { type EditorRouter, ROUTE_ERRORS } from './editor-router.js';
import type { LibrarySource } from './library.js';
import type { BoardStore } from './store.js';

export const OUTSIDE_LIBRARY = 'outside_library';

export interface ProjectActionsOptions {
  store: BoardStore;
  library: LibrarySource;
  roots: () => readonly string[];
  /** Puts the new project on the board; defaults to a plain `manual` project. */
  add?: (project: Project) => void;
  now?: () => number;
  /** Runs the editor CLI for `project.openInEditor`. */
  launcher: Pick<EditorLauncher, 'open'>;
}

/**
 * The library path check every launch goes through (PRD §8 item 10): the project's folder must
 * still resolve inside a configured root. Its realpath when it does, so a launch uses the path
 * that passed the check, never the stored one (a symlink swapped in between would escape).
 */
export function libraryResolver(
  options: Pick<ProjectActionsOptions, 'store' | 'library' | 'roots'>,
) {
  const { store, library, roots } = options;
  return async (projectId: string): Promise<{ ok: true; real: string } | ActionResult> => {
    const project = store.state.projects[projectId];
    if (!project) return { ok: false, error: ROUTE_ERRORS.unknownProject };
    const real = await library.resolve(roots(), project.path);
    return real === null ? { ok: false, error: OUTSIDE_LIBRARY } : { ok: true, real };
  };
}

/** `libraryResolver` as a guard: null when the project's folder is inside a root. */
export function libraryGuard(options: Pick<ProjectActionsOptions, 'store' | 'library' | 'roots'>) {
  const resolve = libraryResolver(options);
  return async (projectId: string): Promise<ActionResult | null> => {
    const resolved = await resolve(projectId);
    return 'real' in resolved ? null : resolved;
  };
}

/**
 * `project.add` from the open-project picker (F25): only a folder the library resolves inside a
 * configured root joins the board. A folder already on it is left as it is.
 * `project.openInEditor` runs the editor CLI on a library project's folder.
 */
export function createProjectActions(
  options: ProjectActionsOptions,
): Pick<ActionHandlers, 'project.add' | 'project.openInEditor'> {
  const { store, library, roots, launcher } = options;
  const resolve = libraryResolver(options);
  const now = options.now ?? Date.now;
  const add = options.add ?? ((project: Project) => store.upsertProject(project));
  return {
    'project.add': async ({ path }) => {
      const real = await library.resolve(roots(), path);
      if (real === null) return { ok: false, error: OUTSIDE_LIBRARY };
      const id = projectIdFromPath(real);
      if (store.state.projects[id]) {
        store.reopenProject(id);
        store.touchProject(id);
        return { ok: true };
      }
      const ts = now();
      add({
        id,
        path: real,
        name: basename(real),
        accent: accentIndexForProject(id),
        source: 'manual',
        git: null,
        createdAt: ts,
        lastActivityAt: ts,
      });
      return { ok: true };
    },
    'project.openInEditor': async ({ projectId }) => {
      const resolved = await resolve(projectId);
      if (!('real' in resolved)) return resolved;
      const opened = await launcher.open(resolved.real);
      if (!opened.ok) return opened;
      store.reopenProject(projectId);
      store.touchProject(projectId);
      return { ok: true, editor: opened.editor };
    },
  };
}

export interface LaunchGuardOptions
  extends Pick<ProjectActionsOptions, 'store' | 'library' | 'roots'> {
  router: EditorRouter;
  /** The editor bridge's `terminal.create`. */
  editorTerminal: ActionHandler<'terminal.create'>;
  /** Board-owned terminals, for a project no connected editor window has open. */
  boardTerminal?: ActionHandler<'terminal.create'>;
  sessionCreate: ActionHandler<'session.create'>;
}

/**
 * Launches from the board, routed and path-checked: `terminal.create` goes to the project's
 * connected editor window, else to a board terminal in a library folder. `session.create` runs
 * in any project an editor or Claude reported, and in a library project while its folder is
 * still inside a root.
 */
export function createLaunchActions(
  options: LaunchGuardOptions,
): Pick<ActionHandlers, 'terminal.create' | 'session.create'> {
  const { store, router, editorTerminal, boardTerminal, sessionCreate } = options;
  const guard = libraryGuard(options);
  return {
    'terminal.create': async (action) => {
      const route = router.forProject(action.projectId);
      if (route.ok) return editorTerminal(action);
      if (route.error === ROUTE_ERRORS.unknownProject || !boardTerminal) return route;
      const refused = await guard(action.projectId);
      return refused ?? boardTerminal(action);
    },
    'session.create': async (action) => {
      const project = store.state.projects[action.projectId];
      if (project?.source === 'manual') {
        const refused = await guard(action.projectId);
        if (refused) return refused;
      }
      return sessionCreate(action);
    },
  };
}

export interface CloseActionsOptions {
  store: BoardStore;
  /** Board terminals in the project: Ctrl+C, then killed if still running a moment later. */
  stopTerminals: (projectId: string) => void;
  /** Board Claude sessions in the project: interrupted, so History can resume them. */
  suspendSessions: (projectId: string) => Promise<void>;
  /** The editor windows open on the project, closed (only when the user asked). */
  closeWindows: (projectId: string) => Promise<ActionResult>;
  /** Drops the project from the overview's pins. */
  unpin: (projectId: string) => void;
  now?: () => number;
}

export const WINDOW_NOT_CLOSED = 'window_not_closed';

/**
 * `project.close`: stops what the board owns in the project (terminal-origin sessions
 * and editor terminals keep running, just hidden), optionally closes its editor windows, unpins
 * it and marks it closed. `project.forget` does the same, then drops it from the board and so
 * from the picker's recents; it comes back only when it is opened again or something runs there.
 */
export function createCloseActions(
  options: CloseActionsOptions,
): Pick<ActionHandlers, 'project.close' | 'project.forget'> {
  const { store, stopTerminals, suspendSessions, closeWindows, unpin } = options;
  const now = options.now ?? Date.now;
  const close = async (projectId: string, closeWindow: boolean): Promise<ActionResult> => {
    if (!store.state.projects[projectId]) return { ok: false, error: ROUTE_ERRORS.unknownProject };
    stopTerminals(projectId);
    await suspendSessions(projectId);
    unpin(projectId);
    const windows = closeWindow ? await closeWindows(projectId) : { ok: true as const };
    store.closeProject(projectId, now());
    return windows.ok ? { ok: true } : { ok: false, error: WINDOW_NOT_CLOSED };
  };
  return {
    'project.close': ({ projectId, closeWindow }) => close(projectId, closeWindow === true),
    'project.forget': async ({ projectId, closeWindow }) => {
      const closed = await close(projectId, closeWindow === true);
      if (!closed.ok && closed.error === ROUTE_ERRORS.unknownProject) return closed;
      store.removeProject(projectId);
      return closed;
    },
  };
}
