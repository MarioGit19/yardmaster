import type { ClaudeSession, GitInfo, GitWorktree, Project } from './domain.js';
import { projectIdFromPath } from './project.js';

/** The worktree holding `path`: the deepest, as a linked worktree can sit inside the main one. */
export function worktreeContaining(
  worktrees: readonly GitWorktree[],
  path: string,
): GitWorktree | null {
  let best: GitWorktree | null = null;
  for (const worktree of worktrees) {
    const root = worktree.path.replace(/\/+$/, '');
    if (path !== root && !path.startsWith(`${root}/`)) continue;
    if (!best || root.length > best.path.length) best = worktree;
  }
  return best;
}

/** The linked worktree a session works in, by what its statusline or `cwd` says. */
export function sessionWorktree(
  session: Pick<ClaudeSession, 'cwd' | 'meter'>,
  git: Pick<GitInfo, 'worktrees'> | null | undefined,
): GitWorktree | null {
  const path = session.meter?.worktree?.path ?? session.cwd;
  if (!path) return null;
  const found = worktreeContaining(git?.worktrees ?? [], path);
  return found && !found.main ? found : null;
}

/** The board's project for a linked worktree's main checkout, when both are on the board. */
export function worktreeParent<T extends Pick<Project, 'id' | 'git'>>(
  project: T,
  projects: Readonly<Record<string, T>>,
): T | null {
  const main = project.git?.mainWorktree;
  if (!main) return null;
  const parent = projects[projectIdFromPath(main)];
  return parent && parent.id !== project.id ? parent : null;
}

/** `projects` with each linked worktree moved right behind its main checkout. */
export function groupWorktrees<T extends Pick<Project, 'id' | 'git'>>(projects: readonly T[]): T[] {
  const byId = Object.fromEntries(projects.map((project) => [project.id, project]));
  const children = new Map<string, T[]>();
  const top: T[] = [];
  for (const project of projects) {
    const parent = worktreeParent(project, byId);
    if (!parent) {
      top.push(project);
      continue;
    }
    const siblings = children.get(parent.id);
    if (siblings) siblings.push(project);
    else children.set(parent.id, [project]);
  }
  return top.flatMap((project) => [project, ...(children.get(project.id) ?? [])]);
}
