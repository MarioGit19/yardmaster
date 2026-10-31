import type { ActionHandlers } from '../actions.js';
import type { BoardStore } from '../store.js';

/** Writes a name into a session's transcript, where Claude Code reads it too. */
export type SessionRenamer = (
  sessionId: string,
  title: string,
  cwd: string | null,
) => Promise<void>;

/** Touches the local transcript only; no API call or login involved. */
const sdkRename: SessionRenamer = async (sessionId, title, cwd) => {
  const { renameSession } = await import('@anthropic-ai/claude-agent-sdk');
  await renameSession(sessionId, title, cwd ? { dir: cwd } : undefined);
};

export interface SessionListActionsOptions {
  store: BoardStore;
  /** Defaults to the Agent SDK's `renameSession`. */
  rename?: SessionRenamer;
  now?: () => number;
}

/**
 * Naming sessions and tidying them off the lists. Neither is session activity: both keep
 * `updatedAt`, so a rename doesn't move a row.
 */
export function createSessionListActions({
  store,
  rename = sdkRename,
  now = Date.now,
}: SessionListActionsOptions): Pick<ActionHandlers, 'session.rename' | 'session.archive'> {
  return {
    'session.rename': async ({ sessionId, title }) => {
      const session = store.state.sessions[sessionId];
      if (!session) return { ok: false, error: 'unknown_session' };
      const name = title.replace(/\s+/g, ' ').trim();
      if (session.origin === 'terminal') {
        store.updateSession(sessionId, {
          boardTitle: name || null,
          updatedAt: session.updatedAt,
        });
        return { ok: true };
      }
      if (!name) return { ok: false, error: 'empty_title' };
      await rename(sessionId, name, session.cwd);
      store.updateSession(sessionId, {
        customTitle: name,
        // From an earlier life as a terminal session; it would hide the new name.
        boardTitle: null,
        updatedAt: session.updatedAt,
      });
      return { ok: true };
    },
    'session.archive': ({ sessionId, archived }) => {
      const session = store.state.sessions[sessionId];
      if (!session) return { ok: false, error: 'unknown_session' };
      if (archived && session.status.kind !== 'ended') return { ok: false, error: 'session_live' };
      store.updateSession(sessionId, {
        archivedAt: archived ? now() : null,
        updatedAt: session.updatedAt,
      });
      return { ok: true };
    },
  };
}
