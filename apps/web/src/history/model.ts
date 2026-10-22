import type { SessionHistoryEntry } from '@c-board/protocol';

/** Past sessions not already on the board, newest first. */
export function pastSessions(
  entries: readonly SessionHistoryEntry[],
  knownIds: ReadonlySet<string>,
): SessionHistoryEntry[] {
  return entries.filter((e) => !knownIds.has(e.id)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The AI (or user-set) title, else the first prompt. */
export const historyTitle = (entry: Pick<SessionHistoryEntry, 'title' | 'firstPrompt'>) =>
  entry.title ?? entry.firstPrompt ?? 'Untitled session';

/** Total tokens, or null when the board never saw the session's usage. */
export function historyTokens(entry: Pick<SessionHistoryEntry, 'tokens'>): number | null {
  if (!entry.tokens) return null;
  const { input, output, cacheRead, cacheCreation } = entry.tokens;
  return input + output + cacheRead + cacheCreation;
}
