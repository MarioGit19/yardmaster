import { describe, expect, it, vi } from 'vitest';
import { OPEN_MESSAGE as APP_OPEN_MESSAGE } from './push.js';
import {
  boardRoute,
  type ClickDeps,
  closeAnswered,
  OPEN_MESSAGE,
  readPayload,
  routeClick,
  showOptions,
  type WindowLike,
} from './sw-logic.js';

const ORIGIN = 'https://dev-mac.tailnet-acme.ts.net';
const SESSION_URL = '/#/p/proj-acme/s/sess-1';

function windowAt(url: string, focused = false): WindowLike & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    url,
    focused,
    messages,
    focus: vi.fn(async () => {}),
    postMessage: (message) => messages.push(message),
  };
}

function deps(
  windows: WindowLike[] = [],
  ok = true,
): ClickDeps & {
  fetch: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
} {
  return {
    origin: ORIGIN,
    fetch: vi.fn(async () => ({ ok })),
    session: async () => 'sess-1234.secret-abcdefghijklmnopqrstuv',
    windows: async () => windows,
    openWindow: vi.fn(async () => null),
  };
}

const approvalData = { url: SESSION_URL, request: 'ap-1', approvalId: 'ap-1' };

describe('routeClick', () => {
  it('focuses an open board tab and sends it to the deep link', async () => {
    const other = windowAt('https://example.test/');
    const board = windowAt(`${ORIGIN}/#/`);
    const d = deps([other, board]);
    await expect(routeClick('', { url: SESSION_URL }, d)).resolves.toBe('focused');
    expect(board.focus).toHaveBeenCalled();
    expect(board.messages).toEqual([{ type: OPEN_MESSAGE, url: SESSION_URL }]);
    expect(other.focus).not.toHaveBeenCalled();
    expect(d.openWindow).not.toHaveBeenCalled();
  });

  it('prefers the focused board tab', async () => {
    const first = windowAt(`${ORIGIN}/#/`);
    const focused = windowAt(`${ORIGIN}/#/settings`, true);
    await routeClick('', { url: SESSION_URL }, deps([first, focused]));
    expect(focused.messages).toHaveLength(1);
    expect(first.messages).toHaveLength(0);
  });

  it('opens a new tab on the deep link when no board is open', async () => {
    const d = deps([]);
    await expect(routeClick('', { url: '/#/p/proj-acme/t/term-1' }, d)).resolves.toBe('opened');
    expect(d.openWindow).toHaveBeenCalledWith('/#/p/proj-acme/t/term-1');
  });

  it('decides an approval from Allow or Deny without opening the board', async () => {
    for (const action of ['allow', 'deny'] as const) {
      const board = windowAt(`${ORIGIN}/`);
      const d = deps([board]);
      await expect(routeClick(action, approvalData, d)).resolves.toBe('decided');
      expect(d.fetch).toHaveBeenCalledWith(
        '/api/approvals/ap-1/decision',
        expect.objectContaining({
          method: 'POST',
          // The session from IndexedDB, never a cookie.
          credentials: 'omit',
          headers: expect.objectContaining({
            'x-yardmaster-session': 'sess-1234.secret-abcdefghijklmnopqrstuv',
          }),
          body: JSON.stringify({ decision: action }),
        }),
      );
      expect(board.focus).not.toHaveBeenCalled();
    }
  });

  it('opens the request when the decision fails (already answered, offline)', async () => {
    const refused = deps([], false);
    await expect(routeClick('allow', approvalData, refused)).resolves.toBe('opened');
    expect(refused.openWindow).toHaveBeenCalledWith(SESSION_URL);

    const offline = deps([]);
    offline.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(routeClick('deny', approvalData, offline)).resolves.toBe('opened');
  });

  it('treats the body tap of an approval as opening it, not deciding', async () => {
    const d = deps([]);
    await routeClick('', approvalData, d);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.openWindow).toHaveBeenCalledWith(SESSION_URL);
  });

  it('never leaves the board, whatever the data says', async () => {
    const d = deps([]);
    await routeClick('', { url: 'https://evil.test/#/p/x' }, d);
    await routeClick('', null, d);
    expect(d.openWindow.mock.calls).toEqual([['/'], ['/']]);
    expect(boardRoute('//evil.test/x', ORIGIN)).toBe('/');
  });
});

describe('payloads', () => {
  it('reads what the board sends and nothing else', () => {
    expect(readPayload({ type: 'close', tag: 'project:a', request: 'ap-1' })).toEqual({
      type: 'close',
      tag: 'project:a',
      request: 'ap-1',
    });
    expect(
      readPayload({ type: 'show', title: 'acme-shop · Claude finished', tag: 't' }),
    ).toMatchObject({ type: 'show', body: '', url: '/', approvalId: null });
    for (const junk of [null, 'text', { type: 'show' }, { type: 'other', tag: 't' }]) {
      expect(readPayload(junk)).toBeNull();
    }
  });

  it('gives approvals Allow / Deny only when the board offered them', () => {
    const base = {
      type: 'show' as const,
      kind: 'needs_you' as const,
      title: 'acme-shop · Claude wants to run Bash',
      body: 'rm -rf dist',
      tag: 'project:acme',
      url: SESSION_URL,
      request: 'ap-1',
      ts: 0,
    };
    expect(showOptions({ ...base, approvalId: 'ap-1' }).actions.map((a) => a.title)).toEqual([
      'Allow once',
      'Deny',
    ]);
    const plain = showOptions({ ...base, approvalId: null });
    expect(plain.actions).toEqual([]);
    expect(plain).toMatchObject({ tag: 'project:acme', renotify: true, data: { request: 'ap-1' } });
    expect(showOptions({ ...base, kind: 'claude_finished', approvalId: null }).renotify).toBe(
      false,
    );
  });

  it('closes only the notifications about the answered request', () => {
    const answered = { data: { request: 'ap-1' }, close: vi.fn() };
    const other = { data: { request: 'ap-2' }, close: vi.fn() };
    expect(closeAnswered([answered, other], 'ap-1')).toBe(1);
    expect(answered.close).toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
  });

  it('uses the message the app listens for', () => {
    expect(APP_OPEN_MESSAGE).toBe(OPEN_MESSAGE);
  });
});
