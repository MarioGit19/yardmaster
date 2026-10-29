import {
  SESSION_HEADER,
  SESSION_PROTOCOL_PREFIX,
  SESSION_STORAGE_KEY,
  SessionSecret,
  UI_WS_PROTOCOL,
} from '@yardmaster/protocol';
import { useSyncExternalStore } from 'react';
import { writeStoredSession } from './idb.js';

// This browser's session secret (PRD §8 item 3). The sign-in page (`/auth?c=`, `/pair?c=`) puts
// it in this origin's localStorage; it never travels in a cookie, so a dev server on another port
// of the same host never sees it. Fetches send it as a header, the board socket as a subprotocol.

const listeners = new Set<() => void>();
let signedOut = false;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function idb(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB;
  } catch {
    return undefined;
  }
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** The stored secret, or null when this browser isn't signed in. */
export function sessionSecret(): string | null {
  const value = storage()?.getItem(SESSION_STORAGE_KEY) ?? null;
  return value !== null && SessionSecret.safeParse(value).success ? value : null;
}

/** Headers that sign a fetch to the board in. */
export function sessionHeaders(): Record<string, string> {
  const secret = sessionSecret();
  return secret === null ? {} : { [SESSION_HEADER]: secret };
}

/** Subprotocols for the board socket: the server answers with the first and reads the second. */
export function sessionProtocols(secret = sessionSecret()): string[] {
  return secret === null
    ? [UI_WS_PROTOCOL]
    : [UI_WS_PROTOCOL, `${SESSION_PROTOCOL_PREFIX}${secret}`];
}

/** Stores a fresh secret (token rotation hands the calling browser one) and signs back in. */
export function setSessionSecret(secret: string): void {
  if (!SessionSecret.safeParse(secret).success) return;
  storage()?.setItem(SESSION_STORAGE_KEY, secret);
  void writeStoredSession(idb(), secret);
  signedOut = false;
  emit();
}

/**
 * The board refused `used` (revoked, expired, rotated, or from before per-browser sessions). A
 * newer secret may have arrived meanwhile, e.g. from a rotation: then nothing changes.
 */
export function markSignedOut(used: string | null): void {
  if (used !== sessionSecret()) return;
  if (used !== null) {
    storage()?.removeItem(SESSION_STORAGE_KEY);
    void writeStoredSession(idb(), null);
  }
  if (signedOut) return;
  signedOut = true;
  emit();
}

/** Whether this browser needs to sign in (or pair) again. */
export function isSignedOut(): boolean {
  return signedOut || sessionSecret() === null;
}

/** Called when this browser signs in or out, here or in another tab. */
export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSignedOut(): boolean {
  return useSyncExternalStore(onSessionChange, isSignedOut, () => false);
}

/**
 * Keeps the service worker's copy in step and follows sign-ins in other tabs (a sign-in link
 * opens a new tab; this one picks the secret up). Returns the cleanup.
 */
export function startSessionSync(): () => void {
  void writeStoredSession(idb(), sessionSecret());
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SESSION_STORAGE_KEY && event.key !== null) return;
    if (sessionSecret() !== null) signedOut = false;
    emit();
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => globalThis.removeEventListener?.('storage', onStorage);
}

/** `fetch` to the board with this browser's session; a 401 means it needs to sign in again. */
export async function boardFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const used = sessionSecret();
  const res = await fetch(url, {
    ...init,
    credentials: 'omit',
    headers: { ...(init.headers as Record<string, string> | undefined), ...sessionHeaders() },
  });
  if (res.status === 401) markSignedOut(used);
  return res;
}
