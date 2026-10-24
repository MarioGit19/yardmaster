import type { Dirent, Stats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import type {
  LibraryEntry,
  LibraryResponse,
  LibraryRootError,
  LibraryRootStatus,
  Project,
} from '@yardmaster/protocol';

/** Folders listed per root at most; a root with more is cut off (alphabetically). */
export const LIBRARY_MAX_ENTRIES = 500;

/**
 * The only file system calls the library makes (PRD §8 item 10): it resolves paths, lists a
 * root's names and stats directories, so nothing under a root is ever opened or read.
 */
export interface LibraryFs {
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<Dirent[]>;
  stat(path: string): Promise<Stats>;
}

export const diskLibraryFs: LibraryFs = {
  realpath: (path) => fsp.realpath(path),
  readdir: (path) => fsp.readdir(path, { withFileTypes: true }),
  stat: (path) => fsp.stat(path),
};

const ROOT_MESSAGES: Record<LibraryRootError, string> = {
  permission:
    'macOS blocks access to this folder. Allow it under System Settings → Privacy & Security → Files and Folders, then reload.',
  missing: 'This folder does not exist.',
  not_directory: 'This is a file, not a folder.',
  unreadable: 'This folder could not be read.',
};

function rootError(err: unknown): LibraryRootError {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'EPERM' || code === 'EACCES') return 'permission';
  if (code === 'ENOENT') return 'missing';
  if (code === 'ENOTDIR') return 'not_directory';
  return 'unreadable';
}

/** `~` and `~/…` under the home directory; anything else as given. */
export function expandRoot(root: string, home = homedir()): string {
  if (root === '~') return home;
  if (root.startsWith('~/')) return join(home, root.slice(2));
  return root;
}

/** `child` is strictly inside `parent` (both resolved, absolute). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

const hidden = (name: string) => name.startsWith('.');

interface Listed {
  name: string;
  path: string;
  root: string;
  git: boolean;
}

/** What `GET /api/library` lists from; the demo board swaps in a synthetic one. */
export interface LibrarySource {
  list(roots: readonly string[], projects: readonly Project[]): Promise<LibraryResponse>;
  /** The realpath of a folder that may be opened from the library, or null. */
  resolve(roots: readonly string[], path: string): Promise<string | null>;
}

export interface ProjectLibraryOptions {
  fs?: LibraryFs;
  home?: string;
}

/**
 * The project library (F25): the top-level directories of each configured root, with whether
 * each is a git repository and when its board project was last active. No recursion, no hidden
 * folders, no files; every path is realpath-checked to be inside a root, so a symlink can't
 * point the picker (or a launch) somewhere else.
 */
export class ProjectLibrary implements LibrarySource {
  private readonly fs: LibraryFs;
  private readonly home: string;

  constructor(options: ProjectLibraryOptions = {}) {
    this.fs = options.fs ?? diskLibraryFs;
    this.home = options.home ?? homedir();
  }

  async list(roots: readonly string[], projects: readonly Project[]): Promise<LibraryResponse> {
    const resolved = await this.resolveRoots(roots);
    const statuses: LibraryRootStatus[] = [];
    const seen = new Set<string>();
    const listed: Listed[] = [];
    for (const { root, real, error } of resolved) {
      if (error || real === null) {
        statuses.push({ root, count: 0, error, message: error ? ROOT_MESSAGES[error] : null });
        continue;
      }
      try {
        const found = await this.listRoot(root, real, resolved);
        let count = 0;
        for (const entry of found) {
          if (seen.has(entry.path)) continue;
          seen.add(entry.path);
          listed.push(entry);
          count++;
        }
        statuses.push({ root, count, error: null, message: null });
      } catch (err) {
        const kind = rootError(err);
        statuses.push({ root, count: 0, error: kind, message: ROOT_MESSAGES[kind] });
      }
    }

    const byPath = new Map(projects.map((p) => [p.path, p]));
    const entries: LibraryEntry[] = listed.map((entry) => {
      const project = byPath.get(entry.path);
      return {
        ...entry,
        projectId: project?.id ?? null,
        lastActiveAt: project ? (project.lastActivityAt ?? project.createdAt) : null,
      };
    });
    entries.sort(
      (a, b) =>
        (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1) ||
        a.name.localeCompare(b.name) ||
        a.path.localeCompare(b.path),
    );
    return { roots: statuses, entries };
  }

  /**
   * The realpath of `path` if it may be opened as a library folder: a visible directory inside a
   * root after resolving symlinks on both sides, or null. Launches (12.3) go through this.
   */
  async resolve(roots: readonly string[], path: string): Promise<string | null> {
    if (!isAbsolute(path)) return null;
    let real: string;
    try {
      real = await this.fs.realpath(path);
      if (!(await this.fs.stat(real)).isDirectory()) return null;
    } catch {
      return null;
    }
    if (hidden(basename(real))) return null;
    const resolved = await this.resolveRoots(roots);
    return resolved.some((r) => r.real !== null && isInside(r.real, real)) ? real : null;
  }

  private async resolveRoots(roots: readonly string[]) {
    return Promise.all(
      roots.map(async (root) => {
        const path = expandRoot(root, this.home);
        if (!isAbsolute(path)) {
          return { root, real: null, error: 'missing' as LibraryRootError };
        }
        try {
          const real = await this.fs.realpath(path);
          if (!(await this.fs.stat(real)).isDirectory()) {
            return { root, real: null, error: 'not_directory' as LibraryRootError };
          }
          return { root, real, error: null };
        } catch (err) {
          return { root, real: null, error: rootError(err) };
        }
      }),
    );
  }

  private async listRoot(
    root: string,
    real: string,
    roots: readonly { real: string | null }[],
  ): Promise<Listed[]> {
    const dirents = await this.fs.readdir(real);
    const names = dirents
      .filter((d) => !hidden(d.name) && (d.isDirectory() || d.isSymbolicLink()))
      // Real folders before symlinks, so an alias never takes a folder's place.
      .sort(
        (a, b) =>
          Number(a.isSymbolicLink()) - Number(b.isSymbolicLink()) || a.name.localeCompare(b.name),
      )
      .slice(0, LIBRARY_MAX_ENTRIES);
    const listed: Listed[] = [];
    for (const dirent of names) {
      const path = await this.folder(join(real, dirent.name), dirent.isSymbolicLink(), roots);
      if (path === null) continue;
      listed.push({ name: dirent.name, path, root, git: await this.exists(join(path, '.git')) });
    }
    return listed;
  }

  /** A directory entry's realpath, if it is a directory inside some root. */
  private async folder(
    path: string,
    symlink: boolean,
    roots: readonly { real: string | null }[],
  ): Promise<string | null> {
    if (!symlink) return path;
    try {
      const real = await this.fs.realpath(path);
      if (!roots.some((r) => r.real !== null && isInside(r.real, real))) return null;
      return (await this.fs.stat(real)).isDirectory() ? real : null;
    } catch {
      return null;
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }
}
