import { z } from 'zod';
import { SessionHistoryEntry } from './claude-sessions.js';
import { Timestamp } from './domain.js';

// JSON bodies of the server's HTTP routes, shared by the CLI, the web app and tests.

export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** `GET /api/status` (authenticated): what `c-board doctor` reports about a running board. */
export const ServerStatus = z.object({
  ok: z.literal(true),
  version: z.string(),
  demo: z.boolean(),
  uptimeMs: z.number().nonnegative(),
  /** Connected Cursor / VS Code windows. */
  editors: z.number().int().nonnegative(),
  hooks: z.object({
    /** Hook events received since the server started. */
    received: z.number().int().nonnegative(),
    lastAt: Timestamp.nullable(),
  }),
});
export type ServerStatus = z.infer<typeof ServerStatus>;

/** `GET /api/projects/:projectId/sessions` (authenticated): past sessions, newest first (F17). */
export const SessionHistoryResponse = z.object({
  sessions: z.array(SessionHistoryEntry),
});
export type SessionHistoryResponse = z.infer<typeof SessionHistoryResponse>;
