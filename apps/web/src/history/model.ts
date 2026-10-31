import {
  type ClaudeSession,
  isArchivedSession,
  type SessionHistoryEntry,
} from '@yardmaster/protocol';

/** Past sessions not already on the board, newest first. */
export function pastSessions(
  entries: readonly SessionHistoryEntry[],
  knownIds: ReadonlySet<string>,
): SessionHistoryEntry[] {
  return entries.filter((e) => !knownIds.has(e.id)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** What History leaves out: sessions listed above it, so not the archived ones. */
export const listedSessionIds = (sessions: readonly ClaudeSession[]): Set<string> =>
  new Set(sessions.filter((s) => !isArchivedSession(s)).map((s) => s.id));

/** Changes when a session ends or is archived, either of which changes History. */
export const historyRefreshKey = (sessions: readonly ClaudeSession[]): string =>
  `${sessions.filter((s) => s.status.kind === 'ended').length}:${sessions.filter(isArchivedSession).length}`;

/** The AI (or user-set) title, else the first prompt. */
export const historyTitle = (entry: Pick<SessionHistoryEntry, 'title' | 'firstPrompt'>) =>
  entry.title ?? entry.firstPrompt ?? 'Untitled session';

/** Total tokens, or null when the board never saw the session's usage. */
export function historyTokens(entry: Pick<SessionHistoryEntry, 'tokens'>): number | null {
  if (!entry.tokens) return null;
  const { input, output, cacheRead, cacheCreation } = entry.tokens;
  return input + output + cacheRead + cacheCreation;
}
