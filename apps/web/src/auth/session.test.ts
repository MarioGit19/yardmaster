// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardFetch,
  isSignedOut,
  markSignedOut,
  onSessionChange,
  sessionHeaders,
  sessionProtocols,
  sessionSecret,
  setSessionSecret,
} from './session.js';

// Synthetic secrets only.
const SECRET = 'AbCdEfGh12345678.secret-part-abcdefghijklmnopqrstuvwxyz0123';
const NEWER = 'ZyXwVuTs87654321.another-secret-abcdefghijklmnopqrstuvwxyz98';

beforeEach(() => {
  localStorage.clear();
  // Leaves the module's signed-out flag clear for the next test.
  setSessionSecret(SECRET);
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('session secret', () => {
  it('reads only a well-formed secret from this origin’s storage', () => {
    expect(sessionSecret()).toBeNull();
    expect(isSignedOut()).toBe(true);
    localStorage.setItem('yardmaster.session', 'not a secret');
    expect(sessionSecret()).toBeNull();
    localStorage.setItem('yardmaster.session', SECRET);
    expect(sessionSecret()).toBe(SECRET);
    expect(isSignedOut()).toBe(false);
  });

  it('becomes a header and the socket’s subprotocols', () => {
    expect(sessionHeaders()).toEqual({});
    expect(sessionProtocols()).toEqual(['yardmaster']);
    setSessionSecret(SECRET);
    expect(sessionHeaders()).toEqual({ 'x-yardmaster-session': SECRET });
    expect(sessionProtocols()).toEqual(['yardmaster', `yardmaster.session.${SECRET}`]);
  });

  it('signs out when the board refuses the secret, and back in with a new one', () => {
    const changed = vi.fn();
    const off = onSessionChange(changed);
    setSessionSecret(SECRET);
    markSignedOut(SECRET);
    expect(isSignedOut()).toBe(true);
    expect(localStorage.getItem('yardmaster.session')).toBeNull();
    setSessionSecret(NEWER);
    expect(isSignedOut()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(3);
    off();
  });

  it('ignores a refusal of an older secret (a rotation already handed out a new one)', () => {
    setSessionSecret(NEWER);
    markSignedOut(SECRET);
    expect(isSignedOut()).toBe(false);
    expect(sessionSecret()).toBe(NEWER);
  });
});

describe('boardFetch', () => {
  it('sends the session header and no cookies', async () => {
    setSessionSecret(SECRET);
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await boardFetch('/api/status', { headers: { accept: 'application/json' } });
    expect(fetch).toHaveBeenCalledWith('/api/status', {
      credentials: 'omit',
      headers: { accept: 'application/json', 'x-yardmaster-session': SECRET },
    });
  });

  it('signs out on a 401', async () => {
    setSessionSecret(SECRET);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })),
    );
    await boardFetch('/api/status');
    expect(isSignedOut()).toBe(true);
  });
});
