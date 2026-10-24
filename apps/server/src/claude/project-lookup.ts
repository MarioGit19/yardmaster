import { realpath } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import {
  accentIndexForProject,
  type Project,
  type ProjectSource,
  projectIdFromPath,
} from '@yardmaster/protocol';
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
  return deepestProject(store.state.projects, path) ?? ensureProject(store, path, 'hook', ts);
}

/** The id of the deepest project whose folder contains the resolved `path`, if any. */
export function deepestProject(
  projects: Readonly<Record<string, Pick<Project, 'id' | 'path'>>>,
  path: string,
): string | null {
  let best: { id: string; depth: number } | null = null;
  for (const project of Object.values(projects)) {
    const root = project.path.replace(/\/+$/, '');
    if (path !== root && !path.startsWith(root === '' ? sep : `${root}${sep}`)) continue;
    if (!best || root.length > best.depth) best = { id: project.id, depth: root.length };
  }
  return best?.id ?? null;
}

/**
 * The project at exactly `path` (a resolved folder), created when missing. An editor
 * opening a folder first seen through a hook promotes it to an `editor` project.
 */
export function ensureProject(
  store: BoardStore,
  path: string,
  source: ProjectSource,
  ts: number,
): string {
  const id = projectIdFromPath(path);
  const existing = store.state.projects[id];
  if (existing) {
    if (source === 'editor' && existing.source === 'hook') {
      store.upsertProject({ ...existing, source });
    }
    return id;
  }
  store.upsertProject({
    id,
    path,
    name: basename(path) || path,
    accent: accentIndexForProject(id),
    source,
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
