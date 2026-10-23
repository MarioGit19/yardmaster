import { basename } from 'node:path';
import { accentIndexForProject, type Project, projectIdFromPath } from '@c-board/protocol';
import type { ActionHandlers } from './actions.js';
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
}

/**
 * `project.add` from the open-project picker (F25): only a folder the library resolves inside a
 * configured root joins the board. A folder already on it is left as it is.
 */
export function createProjectActions(
  options: ProjectActionsOptions,
): Pick<ActionHandlers, 'project.add'> {
  const { store, library, roots } = options;
  const now = options.now ?? Date.now;
  const add = options.add ?? ((project: Project) => store.upsertProject(project));
  return {
    'project.add': async ({ path }) => {
      const real = await library.resolve(roots(), path);
      if (real === null) return { ok: false, error: OUTSIDE_LIBRARY };
      const id = projectIdFromPath(real);
      if (store.state.projects[id]) {
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
  };
}
