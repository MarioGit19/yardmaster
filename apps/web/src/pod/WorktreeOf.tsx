import { type Project, worktreeParent } from '@yardmaster/protocol';
import { GitBranch } from 'lucide-react';
import { useBoard } from '../data/index.js';

/** Marks a project that is a linked worktree of another one on the board. */
export function WorktreeOf({ project }: { project: Project }) {
  const parent = useBoard((s) => worktreeParent(project, s.board.projects));
  if (!parent) return null;
  return (
    <span
      data-worktree-of={parent.id}
      title={`Worktree of ${parent.name}`}
      className="flex min-w-0 max-w-[45%] shrink items-center gap-1 font-mono text-meta text-text-2"
    >
      <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{parent.name}</span>
      <span className="sr-only"> worktree</span>
    </span>
  );
}
