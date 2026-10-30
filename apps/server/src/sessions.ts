import { createHash, randomBytes } from 'node:crypto';
import {
  type BrowserSession,
  type BrowserSessionKind,
  type BrowserSessionsResponse,
  MAX_SEEN_MARKS,
  PAIRING_CODE_TTL_MS,
  REMOTE_SESSION_IDLE_MS,
  SeenMarks,
  type SeenResponse,
  SeenUpdate,
  SIGN_IN_CODE_TTL_MS,
} from '@yardmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deviceName } from './remote.js';
import { tokensEqual } from './token.js';

export const SESSIONS_KEY = 'auth.sessions';
/** A hash of the token the stored sessions belong to; a different token ends them all. */
export const SESSIONS_TOKEN_KEY = 'auth.sessionsToken';
/** Oldest (least recently used) out once there are more. */
export const MAX_SESSIONS = 50;
/** Live sign-in codes at a time; the oldest stops working past this. */
const MAX_SIGN_IN_CODES = 16;
/** `lastSeenAt` is written at most this often per session. */
const SEEN_WRITE_MS = 5 * 60 * 1000;

const StoredSession = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  kind: z.enum(['local', 'remote']),
  name: z.string().max(80),
  /** sha256 of the secret, base64url. The secret itself is never stored. */
  hash: z.string().min(1).max(128),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int(),
  /** What this browser has opened, so each device clears its own Done and Failed marks. */
  seen: SeenMarks.optional(),
});
type StoredSession = z.infer<typeof StoredSession>;

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('base64url');

interface TrackedSocket {
  close(code?: number, reason?: string): void;
  once(event: 'close', listener: () => void): unknown;
}

export interface BrowserSessionsOptions {
  /** Persists the session list (the `settings` table). */
  load(): unknown;
  save(sessions: unknown): void;
  now?: () => number;
}

export type RedeemResult =
  | { ok: true; session: BrowserSession; secret: string }
  | { ok: false; error: 'invalid' | 'expired' };

/**
 * Per-browser sessions (PRD §8 items 3 and 12). A session starts only at a sign-in moment: a
 * one-time sign-in code on this machine, or a phone's pairing code. Each has its own secret
 * (`<id>.<secret>`), so one can be revoked without the others. Remote sessions end after 30 days
 * unused; rotating the token ends them all.
 */
export class BrowserSessions {
  private readonly options: BrowserSessionsOptions;
  private readonly now: () => number;
  private sessions: StoredSession[];
  private pairing: { hash: string; expiresAt: number } | null = null;
  private signIn: { hash: string; expiresAt: number }[] = [];
  private readonly revokeListeners = new Set<(id: string) => void>();

  constructor(options: BrowserSessionsOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    const stored = options.load();
    this.sessions = Array.isArray(stored)
      ? stored.flatMap((s) => {
          const parsed = StoredSession.safeParse(s);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  }

  /** A sign-in code for a browser on this machine (`/auth?c=`): single use, 5 minutes. */
  createSignInCode(): { code: string; expiresAt: number } {
    const code = randomBytes(18).toString('base64url');
    const now = this.now();
    const expiresAt = now + SIGN_IN_CODE_TTL_MS;
    this.signIn = [
      ...this.signIn.filter((c) => c.expiresAt >= now),
      { hash: hashSecret(code), expiresAt },
    ].slice(-MAX_SIGN_IN_CODES);
    return { code, expiresAt };
  }

  /** A pairing code for a phone (`/pair?c=`); any earlier one stops working. */
  createPairingCode(): { code: string; expiresAt: number } {
    const code = randomBytes(18).toString('base64url');
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.pairing = { hash: hashSecret(code), expiresAt };
    return { code, expiresAt };
  }

  /** Spends a sign-in code (right or expired) and starts a local session. */
  redeemSignIn(code: string, userAgent: string | undefined): RedeemResult {
    const hash = hashSecret(code);
    const live = this.signIn.find((c) => tokensEqual(hash, c.hash));
    if (!live) return { ok: false, error: 'invalid' };
    this.signIn = this.signIn.filter((c) => c !== live);
    if (this.now() > live.expiresAt) return { ok: false, error: 'expired' };
    return { ok: true, ...this.create('local', userAgent) };
  }

  /** Spends a pairing code (right or expired) and starts a remote session. */
  redeemPairing(code: string, userAgent: string | undefined): RedeemResult {
    const live = this.pairing;
    if (!live || !tokensEqual(hashSecret(code), live.hash)) return { ok: false, error: 'invalid' };
    this.pairing = null;
    if (this.now() > live.expiresAt) return { ok: false, error: 'expired' };
    return { ok: true, ...this.create('remote', userAgent) };
  }

  /** A new session. Only call this at a sign-in moment, never from an older credential alone. */
  create(
    kind: BrowserSessionKind,
    userAgent: string | undefined,
  ): { session: BrowserSession; secret: string } {
    const id = randomBytes(12).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const now = this.now();
    const stored: StoredSession = {
      id,
      kind,
      name: deviceName(userAgent),
      hash: hashSecret(secret),
      createdAt: now,
      lastSeenAt: now,
    };
    const kept = this.live().sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    const dropped = kept.slice(0, Math.max(0, kept.length + 1 - MAX_SESSIONS));
    this.sessions = [...kept.slice(dropped.length), stored];
    this.persist();
    for (const old of dropped) this.emitRevoke(old.id);
    return { session: this.view(stored, id), secret: `${id}.${secret}` };
  }

  /** The session a secret belongs to, if it is of `kind` and still live, or null. Marks it seen. */
  verify(value: string | undefined, kind: BrowserSessionKind): string | null {
    if (!value) return null;
    const dot = value.indexOf('.');
    if (dot <= 0) return null;
    const id = value.slice(0, dot);
    const session = this.sessions.find((s) => s.id === id);
    if (!session || !tokensEqual(hashSecret(value.slice(dot + 1)), session.hash)) return null;
    if (session.kind !== kind) return null;
    const now = this.now();
    if (this.expired(session, now)) {
      this.revoke(id);
      return null;
    }
    if (now - session.lastSeenAt >= SEEN_WRITE_MS) {
      session.lastSeenAt = now;
      this.persist();
    }
    return id;
  }

  /** Marks a live session as used (its open board socket), sliding a phone's 30 days. */
  touch(id: string): void {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return;
    const now = this.now();
    if (this.expired(session, now) || now - session.lastSeenAt < SEEN_WRITE_MS) return;
    session.lastSeenAt = now;
    this.persist();
  }

  /** What a session's browser has opened, or null for an unknown session. */
  seen(id: string): SeenResponse | null {
    const session = this.sessions.find((s) => s.id === id);
    return session ? { since: session.createdAt, marks: session.seen ?? {} } : null;
  }

  /** Records what a browser opened, newest time winning. False for an unknown session. */
  markSeen(id: string, marks: SeenMarks): boolean {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return false;
    const merged = { ...session.seen };
    for (const [key, at] of Object.entries(marks)) merged[key] = Math.max(merged[key] ?? 0, at);
    const newest = Object.entries(merged)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SEEN_MARKS);
    session.seen = Object.fromEntries(newest);
    this.persist();
    return true;
  }

  /** Ends sessions that expired, closing their open sockets, even if nothing asks for them. */
  sweep(): void {
    this.live();
  }

  has(id: string): boolean {
    return this.live().some((s) => s.id === id);
  }

  /** Live sessions, optionally of one kind, newest first. */
  list(currentId: string | null = null, kind?: BrowserSessionKind): BrowserSession[] {
    return this.live()
      .filter((s) => kind === undefined || s.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => this.view(s, currentId));
  }

  revoke(id: string): boolean {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length === before) return false;
    this.persist();
    this.emitRevoke(id);
    return true;
  }

  /** Ends every session but `except` and forgets every live code (token rotation). */
  revokeAll(except?: string): void {
    const ids = this.sessions.filter((s) => s.id !== except).map((s) => s.id);
    this.sessions = this.sessions.filter((s) => s.id === except);
    this.pairing = null;
    this.signIn = [];
    this.persist();
    for (const id of ids) this.emitRevoke(id);
  }

  /** Calls `listener` with the id of each session that ends. */
  onRevoke(listener: (id: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  /** Closes a session's socket when the session ends. */
  track(id: string, socket: TrackedSocket, code: number): void {
    const listener = (revoked: string) => {
      if (revoked === id) socket.close(code, 'signed_out');
    };
    this.revokeListeners.add(listener);
    socket.once('close', () => this.revokeListeners.delete(listener));
  }

  private expired(session: StoredSession, now: number): boolean {
    return session.kind === 'remote' && now - session.lastSeenAt > REMOTE_SESSION_IDLE_MS;
  }

  private live(): StoredSession[] {
    const now = this.now();
    const expired = this.sessions.filter((s) => this.expired(s, now));
    for (const session of expired) this.revoke(session.id);
    return [...this.sessions];
  }

  private emitRevoke(id: string): void {
    for (const listener of [...this.revokeListeners]) listener(id);
  }

  private view(session: StoredSession, currentId: string | null): BrowserSession {
    const { hash: _hash, seen: _seen, ...rest } = session;
    return { ...rest, current: session.id === currentId };
  }

  private persist(): void {
    this.options.save(this.sessions);
  }
}

const SessionParams = z.object({ id: z.string().min(1).max(64) });

/** Signed-in browsers (Settings → Data and security), under `/api` so the auth guard covers them. */
export function registerSessionRoutes(app: FastifyInstance, sessions: BrowserSessions): void {
  app.get('/api/sessions', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return { sessions: sessions.list(request.browserSession()) } satisfies BrowserSessionsResponse;
  });

  app.get('/api/seen', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const id = request.browserSession();
    const seen = id === null ? null : sessions.seen(id);
    if (!seen) return reply.code(403).send({ error: 'browser_session_required' });
    return seen;
  });

  app.post('/api/seen', async (request, reply) => {
    const body = SeenUpdate.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const id = request.browserSession();
    if (id === null || !sessions.markSeen(id, body.data.marks)) {
      return reply.code(403).send({ error: 'browser_session_required' });
    }
    return { ok: true };
  });

  app.delete('/api/sessions/:id', async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'bad_request' });
    // A phone may sign itself out, never another browser.
    if (request.isRemote() && params.data.id !== request.browserSession()) {
      return reply.code(403).send({ error: 'local_only' });
    }
    if (!sessions.revoke(params.data.id)) return reply.code(404).send({ error: 'unknown_session' });
    app.log.info('signed out a browser session');
    return { ok: true };
  });
}
