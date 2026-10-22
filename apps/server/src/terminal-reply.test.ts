import type { SessionStatus } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { createEditorActions } from './editor-actions.js';
import { EditorRouter, ROUTE_ERRORS } from './editor-router.js';
import { BoardStore } from './store.js';
import {
  createTerminalReply,
  EMPTY_REPLY,
  replyLine,
  TERMINAL_REPLY_DISABLED,
} from './terminal-reply.js';

const T0 = 1_760_000_000_000;
const SESSION = '0b7e4d2c-1a9f-4e3b-8c6d-5f4e3d2c1b0a';

function setup(options: { enabled?: boolean; offline?: string[] } = {}) {
  const store = new BoardStore({ autoFlush: false, now: () => T0 });
  for (const id of ['win-shop', 'win-api']) {
    store.upsertWindow({
      id,
      appName: 'Cursor',
      appVersion: '1.93.0',
      extensionVersion: '0.1.0',
      workspaceFolders: [],
      projectIds: [],
      capabilities: { shellExecution: true },
      connectedAt: T0,
      lastSeenAt: T0,
    });
  }
  store.upsertTerminal({ id: 'term-shop', windowId: 'win-shop', name: 'zsh' });
  store.upsertTerminal({ id: 'term-api', windowId: 'win-api', name: 'claude' });
  store.upsertSession({
    id: SESSION,
    origin: 'terminal',
    terminalId: 'term-api',
    status: { kind: 'waiting_input' },
  });

  let enabled = options.enabled ?? true;
  const sent: { windowId: string; type: string; payload: unknown }[] = [];
  const offline = options.offline ?? [];
  const editor = createEditorActions({
    router: new EditorRouter({
      state: () => store.state,
      isConnected: (windowId) => !offline.includes(windowId),
    }),
    send: async (windowId, type, payload) => {
      sent.push({ windowId, type, payload });
      return { ok: true };
    },
  });
  const reply = createTerminalReply({
    state: () => store.state,
    enabled: () => enabled,
    sendText: editor['terminal.sendText'],
  })['session.replyInTerminal'];
  const send = (text: string, sessionId = SESSION) =>
    reply({ kind: 'session.replyInTerminal', sessionId, text });
  return { store, sent, send, setEnabled: (on: boolean) => (enabled = on) };
}

describe('session.replyInTerminal', () => {
  it("routes the reply to the window owning the session's terminal, submitted", async () => {
    const { send, sent } = setup();
    expect(await send('yes, use the second option')).toEqual({ ok: true });
    expect(sent).toEqual([
      {
        windowId: 'win-api',
        type: 'cmd.sendText',
        payload: { terminalId: 'term-api', text: 'yes, use the second option', execute: true },
      },
    ]);
  });

  it('is refused while the experimental flag is off', async () => {
    const { send, sent, setEnabled } = setup({ enabled: false });
    expect(await send('hi')).toEqual({ ok: false, error: TERMINAL_REPLY_DISABLED });
    setEnabled(true);
    expect(await send('hi')).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it.each([{ kind: 'idle' }, { kind: 'waiting_input' }] as SessionStatus[])(
    'accepts a session that is $kind',
    async (status) => {
      const { store, send } = setup();
      store.setSessionStatus(SESSION, status);
      expect(await send('go on')).toEqual({ ok: true });
    },
  );

  it.each([
    { kind: 'working' },
    { kind: 'tool', tool: 'Bash', toolUseId: null },
    { kind: 'waiting_permission', approvalId: null },
    { kind: 'ended' },
  ] as SessionStatus[])('refuses a session that is $kind', async (status) => {
    const { store, send, sent } = setup();
    store.setSessionStatus(SESSION, status);
    expect(await send('go on')).toEqual({ ok: false, error: 'session_busy' });
    expect(sent).toEqual([]);
  });

  it('refuses unknown, board and unlinked sessions', async () => {
    const { store, send, sent } = setup();
    expect(await send('hi', 'missing')).toEqual({ ok: false, error: 'unknown_session' });
    store.upsertSession({ id: 'board-1', origin: 'board', status: { kind: 'idle' } });
    expect(await send('hi', 'board-1')).toEqual({ ok: false, error: 'not_terminal_session' });
    store.upsertSession({ id: 'loose-1', origin: 'terminal', status: { kind: 'idle' } });
    expect(await send('hi', 'loose-1')).toEqual({ ok: false, error: 'no_linked_terminal' });
    expect(sent).toEqual([]);
  });

  it('passes on routing errors for a closed terminal or an offline editor', async () => {
    const closed = setup();
    closed.store.closeTerminal('term-api', 0);
    expect(await closed.send('hi')).toEqual({ ok: false, error: ROUTE_ERRORS.terminalClosed });
    const offline = setup({ offline: ['win-api'] });
    expect(await offline.send('hi')).toEqual({ ok: false, error: ROUTE_ERRORS.editorOffline });
  });

  it('sends one line without control characters', async () => {
    const { send, sent } = setup();
    expect(await send('first\nsecond\u0003\u001b')).toEqual({ ok: true });
    expect(sent[0]?.payload).toMatchObject({ text: 'first second' });
    expect(await send('\n\u001b\t ')).toEqual({ ok: false, error: EMPTY_REPLY });
  });
});

describe('replyLine', () => {
  it('keeps ordinary text, including non-Latin characters and emoji', () => {
    expect(replyLine('  ok — überprüfe 設定 ✅ ')).toBe('ok — überprüfe 設定 ✅');
    expect(replyLine('a\r\nb\u0085c')).toBe('a b c');
  });
});
