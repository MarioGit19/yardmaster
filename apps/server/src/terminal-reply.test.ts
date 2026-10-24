import type { ServerToUi, SessionStatus } from '@yardmaster/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTuiInput } from './demo/tui-input.js';
import { createEditorActions } from './editor-actions.js';
import { EditorRouter, ROUTE_ERRORS } from './editor-router.js';
import { BoardStore } from './store.js';
import {
  createTerminalReply,
  EMPTY_REPLY,
  ENTER,
  pasted,
  replyText,
  SUBMIT_CONFIRM_MS,
  SUBMIT_DELAY_MS,
  TERMINAL_REPLY_DISABLED,
} from './terminal-reply.js';

const T0 = 1_760_000_000_000;
const SESSION = '0b7e4d2c-1a9f-4e3b-8c6d-5f4e3d2c1b0a';

function setup(options: { enabled?: boolean; offline?: string[]; deaf?: boolean } = {}) {
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
  /** `deaf`: the terminal takes input but Claude never submits it. */
  const tui = { buffer: '', submitted: [] as string[], deaf: options.deaf ?? false };
  const sent: { windowId: string; type: string; payload: unknown }[] = [];
  const offline = options.offline ?? [];
  const editor = createEditorActions({
    router: new EditorRouter({
      state: () => store.state,
      isConnected: (windowId) => !offline.includes(windowId),
    }),
    send: async (windowId, type, payload) => {
      sent.push({ windowId, type, payload });
      const { text, execute } = payload as { text: string; execute: boolean };
      if (tui.deaf) return { ok: true };
      // Claude's TUI in the terminal: a submitted prompt starts a turn (its UserPromptSubmit).
      const input = readTuiInput(tui.buffer, execute ? `${text}\r` : text);
      tui.buffer = input.buffer;
      tui.submitted.push(...input.submitted);
      if (input.submitted.length > 0) {
        store.setSessionStatus(SESSION, { kind: 'working' });
        store.flush();
      }
      return { ok: true };
    },
  });
  const toasts: ServerToUi[] = [];
  const reply = createTerminalReply({
    state: () => store.state,
    enabled: () => enabled,
    sendText: editor['terminal.sendText'],
    onChange: (listener) => store.onPatch(listener),
    notify: (message) => toasts.push(message),
  })['session.replyInTerminal'];
  const send = async (text: string, sessionId = SESSION) => {
    const result = reply({ kind: 'session.replyInTerminal', sessionId, text });
    await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
    return result;
  };
  return { store, sent, toasts, send, tui, setEnabled: (on: boolean) => (enabled = on) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('session.replyInTerminal', () => {
  it("pastes the reply into the session's terminal, then presses Enter on its own", async () => {
    const { send, sent, tui } = setup();
    expect(await send('yes, use the second option')).toEqual({ ok: true });
    expect(sent).toEqual([
      {
        windowId: 'win-api',
        type: 'cmd.sendText',
        payload: {
          terminalId: 'term-api',
          text: '\x1b[200~yes, use the second option\x1b[201~',
          execute: false,
        },
      },
      {
        windowId: 'win-api',
        type: 'cmd.sendText',
        payload: { terminalId: 'term-api', text: ENTER, execute: false },
      },
    ]);
    expect(tui.submitted).toEqual(['yes, use the second option']);
  });

  it('submits a long reply, which the old text-and-Enter write left typed', async () => {
    const long = 'Refactor the cart totals. '.repeat(20).slice(0, 500);
    // The bug: one write of text plus Enter reads as a paste, and the Enter as a newline.
    const legacy = readTuiInput('', `${long}\r`);
    expect(legacy.submitted).toEqual([]);

    const { send, tui, toasts } = setup();
    expect(await send(long)).toEqual({ ok: true });
    expect(tui.submitted).toEqual([long.trim()]);
    await vi.advanceTimersByTimeAsync(2 * SUBMIT_CONFIRM_MS);
    expect(toasts).toEqual([]);
  });

  it('keeps a multi-line reply multi-line', async () => {
    const { send, sent, tui } = setup();
    expect(await send('first\r\nsecond\nthird')).toEqual({ ok: true });
    expect(sent[0]?.payload).toMatchObject({ text: pasted('first\nsecond\nthird') });
    expect(tui.submitted).toEqual(['first\nsecond\nthird']);
  });

  it('presses Enter once more when no turn starts, then tells the board', async () => {
    const { send, sent, toasts, store } = setup({ deaf: true });
    expect(await send('go on')).toEqual({ ok: true });
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_MS);
    expect(sent).toHaveLength(3);
    expect(sent[2]?.payload).toMatchObject({ text: ENTER, execute: false });
    expect(toasts).toEqual([]);
    await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_MS);
    expect(sent).toHaveLength(3);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      type: 'toast',
      payload: {
        level: 'warning',
        title: 'Typed into the terminal but not sent',
        body: 'Press Enter in Cursor.',
        sessionId: SESSION,
        terminalId: 'term-api',
      },
    });
    // A turn that starts late changes nothing further.
    store.setSessionStatus(SESSION, { kind: 'working' });
    store.flush();
    expect(toasts).toHaveLength(1);
  });

  it('stays quiet when the second Enter lands', async () => {
    const { send, sent, toasts, store } = setup({ deaf: true });
    await send('go on');
    await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_MS);
    expect(sent).toHaveLength(3);
    store.setSessionStatus(SESSION, { kind: 'working' });
    store.flush();
    await vi.advanceTimersByTimeAsync(2 * SUBMIT_CONFIRM_MS);
    expect(sent).toHaveLength(3);
    expect(toasts).toEqual([]);
  });

  it('stops watching a session that ends', async () => {
    const { send, sent, toasts, store } = setup({ deaf: true });
    await send('go on');
    store.setSessionStatus(SESSION, { kind: 'ended' });
    store.flush();
    await vi.advanceTimersByTimeAsync(2 * SUBMIT_CONFIRM_MS);
    expect(sent).toHaveLength(2);
    expect(toasts).toEqual([]);
  });

  it('is refused while the setting is off', async () => {
    const { send, sent, setEnabled } = setup({ enabled: false });
    expect(await send('hi')).toEqual({ ok: false, error: TERMINAL_REPLY_DISABLED });
    setEnabled(true);
    expect(await send('hi')).toEqual({ ok: true });
    expect(sent).toHaveLength(2);
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

  it('pastes no control characters, so the paste cannot be closed early', async () => {
    const { send, sent } = setup();
    expect(await send('\n\u001b\t ')).toEqual({ ok: false, error: EMPTY_REPLY });
    expect(await send('first\u0003second\u001b[201~\r')).toEqual({ ok: true });
    expect(sent[0]?.payload).toMatchObject({ text: pasted('first second [201~') });
  });
});

describe('replyText', () => {
  it('keeps ordinary text, including non-Latin characters, emoji and line breaks', () => {
    expect(replyText('  ok — überprüfe 設定 ✅ ')).toBe('ok — überprüfe 設定 ✅');
    expect(replyText('a\r\nb\rc\u0085d')).toBe('a\nb\nc d');
  });
});
