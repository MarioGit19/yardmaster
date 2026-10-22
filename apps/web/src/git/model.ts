import type { GitFileChange, GitFileStatus, GitInfo } from '@c-board/protocol';

export interface FileGroup {
  status: GitFileStatus;
  label: string;
  files: GitFileChange[];
}

/** Display order: what blocks you first, untracked last. */
const GROUPS: { status: GitFileStatus; label: string }[] = [
  { status: 'conflicted', label: 'Conflicts' },
  { status: 'modified', label: 'Modified' },
  { status: 'added', label: 'Added' },
  { status: 'deleted', label: 'Deleted' },
  { status: 'renamed', label: 'Renamed' },
  { status: 'copied', label: 'Copied' },
  { status: 'typechange', label: 'Type changed' },
  { status: 'untracked', label: 'Untracked' },
];

/** Changed files grouped by status, empty groups left out, paths sorted within a group. */
export function groupFiles(files: readonly GitFileChange[]): FileGroup[] {
  const byStatus = new Map<GitFileStatus, GitFileChange[]>();
  for (const file of files) {
    const list = byStatus.get(file.status);
    if (list) list.push(file);
    else byStatus.set(file.status, [file]);
  }
  return GROUPS.flatMap(({ status, label }) => {
    const list = byStatus.get(status);
    if (!list) return [];
    return [{ status, label, files: [...list].sort((a, b) => a.path.localeCompare(b.path)) }];
  });
}

/** `src/lib/cart.ts` → `{ dir: 'src/lib/', name: 'cart.ts' }`. */
export function splitPath(path: string): { dir: string; name: string } {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf('/');
  if (slash < 0) return { dir: '', name: trimmed };
  return { dir: trimmed.slice(0, slash + 1), name: trimmed.slice(slash + 1) };
}

export type SyncState =
  | { kind: 'none' }
  | { kind: 'synced' }
  | { kind: 'diverged'; ahead: number; behind: number };

/** How the branch relates to its upstream. */
export function syncState(git: Pick<GitInfo, 'upstream' | 'ahead' | 'behind'>): SyncState {
  if (git.upstream === null) return { kind: 'none' };
  if (git.ahead === 0 && git.behind === 0) return { kind: 'synced' };
  return { kind: 'diverged', ahead: git.ahead, behind: git.behind };
}

/** Changed files git reported beyond the listed ones. */
export const unlistedCount = (git: Pick<GitInfo, 'dirty' | 'files'>) =>
  Math.max(0, git.dirty - git.files.length);
