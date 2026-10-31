import { describe, expect, it, vi } from 'vitest';
import { restoreBoardSessions } from '../app.js';
import { type SessionRecord, toSessionRecord } from '../persistence.js';
import { BoardStore } from '../store.js';
import { createSessionListActions } from './session-list-actions.js';

const cwd = '/home/dev/acme-shop';

function setup(origin: 'board' | 'terminal', kind: 'idle' | 'ended' = 'idle') {
  const store = new BoardStore();
  store.upsertSession({
    id: 's',
    origin,
    cwd,
    status: { kind },
    customTitle: null,
    updatedAt: 500,
    endedAt: kind === 'ended' ? 500 : null,
  });
  const rename = vi.fn(async () => {});
  return { store, rename, actions: createSessionListActions({ store, rename, now: () => 900 }) };
}

describe('session.rename', () => {
  it('renames a board session through Claude Code', async () => {
    const { store, rename, actions } = setup('board');
    const result = await actions['session.rename']({
      kind: 'session.rename',
      sessionId: 's',
      title: '  Cart   fix ',
    });
    expect(result).toEqual({ ok: true });
    expect(rename).toHaveBeenCalledWith('s', 'Cart fix', cwd);
    expect(store.state.sessions.s?.customTitle).toBe('Cart fix');
    expect(store.state.sessions.s?.updatedAt).toBe(500);
  });

  it('keeps the old name when the transcript write fails', async () => {
    const { store, rename, actions } = setup('board');
    rename.mockRejectedValueOnce(new Error('no transcript'));
    await expect(
      actions['session.rename']({ kind: 'session.rename', sessionId: 's', title: 'Cart' }),
    ).rejects.toThrow('no transcript');
    expect(store.state.sessions.s?.customTitle).toBeNull();
  });

  it('refuses an empty name for a board session', async () => {
    const { rename, actions } = setup('board');
    const result = await actions['session.rename']({
      kind: 'session.rename',
      sessionId: 's',
      title: ' ',
    });
    expect(result).toEqual({ ok: false, error: 'empty_title' });
    expect(rename).not.toHaveBeenCalled();
  });

  it('stores a terminal session name on the board alone, and clears it', async () => {
    const { store, rename, actions } = setup('terminal');
    await actions['session.rename']({ kind: 'session.rename', sessionId: 's', title: 'Mine' });
    expect(store.state.sessions.s?.boardTitle).toBe('Mine');
    expect(rename).not.toHaveBeenCalled();
    await actions['session.rename']({ kind: 'session.rename', sessionId: 's', title: '' });
    expect(store.state.sessions.s?.boardTitle).toBeNull();
  });

  it('rejects an unknown session', async () => {
    const { actions } = setup('terminal');
    expect(
      await actions['session.rename']({ kind: 'session.rename', sessionId: 'x', title: 'a' }),
    ).toEqual({ ok: false, error: 'unknown_session' });
  });
});

describe('session.archive', () => {
  it('archives a finished session and puts it back', async () => {
    const { store, actions } = setup('terminal', 'ended');
    const action = { kind: 'session.archive', sessionId: 's' } as const;
    await actions['session.archive']({ ...action, archived: true });
    expect(store.state.sessions.s?.archivedAt).toBe(900);
    expect(store.state.sessions.s?.updatedAt).toBe(500);
    await actions['session.archive']({ ...action, archived: false });
    expect(store.state.sessions.s?.archivedAt).toBeNull();
  });

  it('refuses a live session', async () => {
    const { store, actions } = setup('terminal');
    expect(
      await actions['session.archive']({
        kind: 'session.archive',
        sessionId: 's',
        archived: true,
      }),
    ).toEqual({ ok: false, error: 'session_live' });
    expect(store.state.sessions.s?.archivedAt).toBeUndefined();
  });
});

describe('after a restart', () => {
  const record = (over: Partial<SessionRecord>): SessionRecord => {
    const { store } = setup('terminal', 'ended');
    const session = store.state.sessions.s;
    if (!session) throw new Error('no session');
    return { ...toSessionRecord(session), projectId: 'p', ...over };
  };
  const board = () => {
    const store = new BoardStore();
    store.upsertProject({
      id: 'p',
      path: cwd,
      name: 'acme-shop',
      accent: 0,
      source: 'editor',
      git: null,
      createdAt: 1,
      lastActivityAt: null,
    });
    return store;
  };

  it('keeps archive marks and board names', () => {
    const store = board();
    restoreBoardSessions(store, [record({ id: 'a', archivedAt: 900 })]);
    restoreBoardSessions(store, [record({ id: 'n', boardTitle: 'Mine', endedAt: null })]);
    expect(store.state.sessions.a?.archivedAt).toBe(900);
    expect(store.state.sessions.n?.boardTitle).toBe('Mine');
    expect(store.state.sessions.n?.status.kind).toBe('ended');
    expect(store.state.sessions.n?.endedAt).toBe(500);
  });

  it('leaves out unmarked sessions and forgotten projects', () => {
    const store = board();
    restoreBoardSessions(store, [
      record({ id: 'plain' }),
      record({ id: 'orphan', projectId: 'gone', archivedAt: 900 }),
    ]);
    expect(store.state.sessions).toEqual({});
  });
});
