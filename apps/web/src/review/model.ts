import type { ClaudeSession, GitReviewFile, GitWorktree } from '@yardmaster/protocol';
import { worktreeContaining } from '@yardmaster/protocol';
import { buildHunk, type Hunk } from '../claude/tools/diff.js';

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A unified diff as the renderer's hunks; each `@@` block is one, numbered from its header. */
export function hunksFromPatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let open: { oldStart: number; newStart: number; before: string[]; after: string[] } | null = null;
  const close = () => {
    if (!open) return;
    const text = (lines: string[]) => (lines.length > 0 ? `${lines.join('\n')}\n` : '');
    hunks.push(buildHunk(text(open.before), text(open.after), open.oldStart, open.newStart));
    open = null;
  };
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      close();
      open = {
        oldStart: Number(header[1]),
        newStart: Number(header[2]),
        before: [],
        after: [],
      };
    } else if (open) {
      if (line.startsWith('-')) open.before.push(line.slice(1));
      else if (line.startsWith('+')) open.after.push(line.slice(1));
      else if (line.startsWith(' ')) {
        open.before.push(line.slice(1));
        open.after.push(line.slice(1));
      }
    }
  }
  close();
  return hunks;
}

/** Per device: which files were read, by content, so a file that changes reads as new again. */
export type ViewedMarks = Readonly<Record<string, string>>;

export const isViewed = (marks: ViewedMarks, file: Pick<GitReviewFile, 'path' | 'sig'>) =>
  marks[file.path] === file.sig;

export function toggleViewed(
  marks: ViewedMarks,
  file: Pick<GitReviewFile, 'path' | 'sig'>,
): ViewedMarks {
  if (isViewed(marks, file)) {
    const { [file.path]: _gone, ...rest } = marks;
    return rest;
  }
  return { ...marks, [file.path]: file.sig };
}

/** The next file still to read after `path`, wrapping around; null when all are read. */
export function nextUnviewed(
  files: readonly GitReviewFile[],
  marks: ViewedMarks,
  path: string,
): string | null {
  const from = files.findIndex((file) => file.path === path);
  for (let step = 1; step <= files.length; step++) {
    const file = files[(from + step) % files.length];
    if (file && file.path !== path && !isViewed(marks, file)) return file.path;
  }
  return null;
}

export function reviewTotals(files: readonly GitReviewFile[]) {
  return {
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    uncommitted: files.filter((file) => file.uncommitted).length,
  };
}

/** The live board session working in the reviewed folder: who "Ask Claude to fix" writes to. */
export function fixSession<
  T extends Pick<ClaudeSession, 'id' | 'origin' | 'status' | 'cwd' | 'updatedAt'>,
>(sessions: readonly T[], worktrees: readonly GitWorktree[], target: string | null): T | null {
  const candidates = sessions.filter((session) => {
    if (session.origin !== 'board' || session.status.kind === 'ended') return false;
    if (worktrees.length === 0 || !session.cwd) return target === null;
    const home = worktreeContaining(worktrees, session.cwd);
    return target === null ? (home?.main ?? true) : home?.id === target;
  });
  return candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

export const fixPrompt = (path: string) =>
  `Review the changes in \`${path}\` and fix anything that's wrong.`;
