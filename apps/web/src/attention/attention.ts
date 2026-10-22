import type { ClaudeSession } from '@c-board/protocol';
import type { BoardStoreState } from '../data/store.js';
import { createPreference, type KeyValueStorage } from '../prefs.js';

// Whether the sheet is open lives only in memory: a reload starts with it closed.
const memory: KeyValueStorage = { getItem: () => null, setItem: () => {} };

export const attentionOpen = createPreference<'open' | 'closed'>(
  'cboard.attention',
  ['open', 'closed'],
  'closed',
  memory,
);

export const isWaiting = (session: Pick<ClaudeSession, 'status'>) =>
  session.status.kind === 'waiting_permission' || session.status.kind === 'waiting_input';

/** Sessions waiting for the user, longest-waiting first. */
export const selectWaitingSessions = (s: BoardStoreState): ClaudeSession[] =>
  Object.values(s.board.sessions)
    .filter(isWaiting)
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
