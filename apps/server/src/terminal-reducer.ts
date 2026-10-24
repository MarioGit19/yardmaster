import type { EditorTerminal, Project, Terminal } from '@yardmaster/protocol';
import { deepestProject } from './claude/project-lookup.js';

export type TerminalEvent =
  | { type: 'upsert'; terminal: EditorTerminal }
  | { type: 'closed'; exitCode: number | null };

export interface TerminalContext {
  /** The window whose connection sent the event. */
  windowId: string;
  projects: Readonly<Record<string, Pick<Project, 'id' | 'path'>>>;
  /** The window's workspace-folder projects, in folder order. */
  windowProjectIds: readonly string[];
  /** The terminal's cwd, resolved like project paths (realpath); null when unknown. */
  resolvedCwd: string | null;
  now: number;
}

/**
 * The project a terminal belongs to: the deepest known project containing its cwd,
 * otherwise the window's first folder.
 */
export function linkTerminalProject(
  ctx: Pick<TerminalContext, 'projects' | 'windowProjectIds' | 'resolvedCwd'>,
): string | null {
  const byCwd = ctx.resolvedCwd === null ? null : deepestProject(ctx.projects, ctx.resolvedCwd);
  return byCwd ?? ctx.windowProjectIds.find((id) => ctx.projects[id] !== undefined) ?? null;
}

/**
 * Applies an editor terminal event. Returns the next terminal, or null when the event
 * must be ignored (an unknown terminal, or one owned by another window).
 */
export function terminalReducer(
  existing: Terminal | undefined,
  event: TerminalEvent,
  ctx: TerminalContext,
): Terminal | null {
  if (existing && existing.windowId !== ctx.windowId) return null;

  if (event.type === 'closed') {
    if (!existing) return null;
    return {
      ...existing,
      state: 'closed',
      active: false,
      exitCode: event.exitCode ?? existing.exitCode,
      closedAt: existing.closedAt ?? ctx.now,
    };
  }

  const input = event.terminal;
  const closed = input.state === 'closed';
  return {
    id: input.terminalId,
    windowId: ctx.windowId,
    projectId: linkTerminalProject(ctx) ?? existing?.projectId ?? null,
    name: input.name,
    // The pid and cwd don't go away; a missing value means "not known right now".
    shellPid: input.shellPid ?? existing?.shellPid ?? null,
    cwd: input.cwd ?? existing?.cwd ?? null,
    state: input.state,
    shellIntegration: input.shellIntegration,
    active: !closed && input.active,
    exitCode: input.exitCode,
    executionIds: existing?.executionIds ?? [],
    stats: existing?.stats ?? null,
    createdAt: existing?.createdAt ?? ctx.now,
    closedAt: closed ? (existing?.closedAt ?? ctx.now) : null,
  };
}
