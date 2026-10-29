import { z } from 'zod';

export * from './session-keys.js';

/** `<id>.<secret>`, both base64url. */
export const SessionSecret = z.string().regex(/^[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{20,128}$/);

/** How long a one-time sign-in code (`/auth?c=`) stays valid. */
export const SIGN_IN_CODE_TTL_MS = 5 * 60 * 1000;
/** A remote (phone) session ends after this long unused; local ones last until revoked. */
export const REMOTE_SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export const BrowserSessionKind = z.enum(['local', 'remote']);
export type BrowserSessionKind = z.infer<typeof BrowserSessionKind>;

export const BrowserSession = z.object({
  id: z.string().min(1).max(64),
  kind: BrowserSessionKind,
  /** From the browser's user agent, such as "Mac · Chrome". */
  name: z.string().max(80),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int(),
  /** The browser making the request. */
  current: z.boolean(),
});
export type BrowserSession = z.infer<typeof BrowserSession>;

/** `GET /api/sessions`: every signed-in browser, newest first. */
export const BrowserSessionsResponse = z.object({ sessions: z.array(BrowserSession) });
export type BrowserSessionsResponse = z.infer<typeof BrowserSessionsResponse>;

/** `POST /api/token/rotate`: every session ends; the calling browser gets a fresh one. */
export const RotateTokenResponse = z.object({
  ok: z.literal(true),
  session: SessionSecret.optional(),
});
export type RotateTokenResponse = z.infer<typeof RotateTokenResponse>;
