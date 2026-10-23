import type { LibraryEntry, LibraryResponse, Project } from '@c-board/protocol';
import type { LibrarySource } from '../library.js';
import { DEMO_HOME } from './content.js';

/** Folders on the demo "desktop" that aren't on the board yet. */
const EXTRA_FOLDERS = [
  { name: 'garden-planner', git: true },
  { name: 'recipe-box', git: true },
  { name: 'tax-notes', git: false },
  { name: 'weather-bot', git: true },
] as const;

/**
 * A synthetic library for the demo board: its projects plus a few folders that aren't open
 * anywhere, all listed under the first configured root. It never touches the disk.
 */
export function demoLibrary(): LibrarySource {
  return {
    async list(roots: readonly string[], projects: readonly Project[]): Promise<LibraryResponse> {
      const root = roots[0];
      if (root === undefined) return { roots: [], entries: [] };
      const entries: LibraryEntry[] = [
        ...projects
          .filter((p) => p.path.startsWith(`${DEMO_HOME}/`))
          .map((p) => ({
            name: p.name,
            path: p.path,
            root,
            git: p.git !== null,
            projectId: p.id,
            lastActiveAt: p.lastActivityAt ?? p.createdAt,
          })),
        ...EXTRA_FOLDERS.map((folder) => ({
          name: folder.name,
          path: `${DEMO_HOME}/${folder.name}`,
          root,
          git: folder.git,
          projectId: null,
          lastActiveAt: null,
        })),
      ];
      entries.sort(
        (a, b) => (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1) || a.name.localeCompare(b.name),
      );
      return {
        roots: roots.map((r, i) => ({
          root: r,
          count: i === 0 ? entries.length : 0,
          error: null,
          message: null,
        })),
        entries,
      };
    },
  };
}
