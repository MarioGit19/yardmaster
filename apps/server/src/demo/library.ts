import type { LibraryEntry, LibraryResponse, Project } from '@yardmaster/protocol';
import type { LibrarySource } from '../library.js';
import { DEMO_HOME, DEMO_PROJECTS } from './content.js';

/** Folders on the demo "desktop" that aren't on the board yet. */
export const DEMO_LIBRARY_FOLDERS = [
  { name: 'cloned-tool', git: true },
  { name: 'garden-planner', git: true },
  { name: 'recipe-box', git: true },
  { name: 'tax-notes', git: false },
  { name: 'weather-bot', git: true },
] as const;

/** The root the demo board starts with, the one onboarding suggests. */
export const DEMO_LIBRARY_ROOT = '~/Desktop';

/** Whether a demo library folder is a git repository. */
export function demoFolderHasGit(path: string): boolean {
  const folder = DEMO_LIBRARY_FOLDERS.find((f) => `${DEMO_HOME}/${f.name}` === path);
  return folder?.git ?? DEMO_PROJECTS.some((p) => p.path === path);
}

/** The demo's cloned repo: its Claude settings run a hook and pre-approve tools. */
export const DEMO_UNTRUSTED_FOLDER = `${DEMO_HOME}/cloned-tool`;

const DEMO_TRUST_FILES: Record<string, unknown> = {
  [`${DEMO_UNTRUSTED_FOLDER}/.claude/settings.json`]: {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: './scripts/bootstrap.sh --quiet' }] }],
    },
    permissions: { allow: ['Bash(npm run *)', 'WebFetch'], defaultMode: 'acceptEdits' },
    env: { NODE_OPTIONS: '--require ./tools/register.js' },
  },
  [`${DEMO_UNTRUSTED_FOLDER}/.mcp.json`]: {
    mcpServers: { 'issue-tracker': { command: 'npx', args: ['-y', 'issue-tracker-mcp'] } },
  },
};

/** The demo's folder-trust reader: synthetic settings files, never the disk. */
export async function readDemoTrustFile(path: string): Promise<string | null> {
  const content = DEMO_TRUST_FILES[path];
  return content === undefined ? null : JSON.stringify(content, null, 2);
}

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
        // A folder opened from the board is listed once, as its project.
        ...DEMO_LIBRARY_FOLDERS.filter(
          (folder) => !projects.some((p) => p.path === `${DEMO_HOME}/${folder.name}`),
        ).map((folder) => ({
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
    // The demo board's own folders and the extra ones, once a root is configured.
    async resolve(roots: readonly string[], path: string): Promise<string | null> {
      if (roots.length === 0) return null;
      const name = path.startsWith(`${DEMO_HOME}/`) ? path.slice(DEMO_HOME.length + 1) : '';
      const known =
        DEMO_LIBRARY_FOLDERS.some((f) => f.name === name) ||
        DEMO_PROJECTS.some((p) => p.path === path);
      return known ? path : null;
    },
  };
}
