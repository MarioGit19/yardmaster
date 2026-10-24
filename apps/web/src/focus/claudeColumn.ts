import type { ClaudeSession } from '@yardmaster/protocol';

/**
 * The session the Claude column shows: the route's, or without one the project's most relevant
 * live session, skipping one the stack took over ("Show here instead"). Undefined: a blank
 * composer (or "no longer available" when the route names a session that isn't there).
 */
export function claudeColumnSession({
  projectId,
  sessionId,
  selected,
  live,
  released,
}: {
  projectId: string;
  sessionId: string | undefined;
  /** The route's session, if the board has it. */
  selected: ClaudeSession | undefined;
  /** The project's live sessions, most relevant first. */
  live: readonly ClaudeSession[];
  released: string | null;
}): ClaudeSession | undefined {
  if (selected?.projectId === projectId) return selected;
  if (sessionId) return undefined;
  return live.find((s) => s.id !== released);
}
