import { realpath } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { accentIndexForProject, projectIdFromPath } from '@c-board/protocol';
import type { BoardStore } from '../store.js';

export type PathResolver = (path: string) => Promise<string>;

/**
 * The known project containing `cwd` (deepest match), or a new `hook` project for it.
 * Null when `cwd` isn't an absolute path.
 */
export async function projectForCwd(
  store: BoardStore,
  cwd: string,
  ts: number,
  resolvePath: PathResolver = resolveDir,
): Promise<string | null> {
  const path = await resolvePath(cwd).catch(() => null);
  if (!path) return null;
  let best: { id: string; depth: number } | null = null;
  for (const project of Object.values(store.state.projects)) {
    const root = project.path.replace(/\/+$/, '');
    if (path !== root && !path.startsWith(root === '' ? sep : `${root}${sep}`)) continue;
    if (!best || root.length > best.depth) best = { id: project.id, depth: root.length };
  }
  if (best) return best.id;

  const id = projectIdFromPath(path);
  store.upsertProject({
    id,
    path,
    name: basename(path) || path,
    accent: accentIndexForProject(id),
    source: 'hook',
    git: null,
    createdAt: ts,
    lastActivityAt: ts,
  });
  return id;
}

/** Realpath when the folder exists, else the normalized absolute path. */
export async function resolveDir(path: string): Promise<string> {
  if (!path.startsWith('/')) throw new Error('cwd is not absolute');
  return realpath(path).catch(() => resolve(path));
}
