import { z } from 'zod';
import type { SessionStatusKind, TerminalState } from './domain.js';

/**
 * The status vocabulary of every layout, the phone, the rail and Pulse (DESIGN.md §2.1). Five
 * tokens in Carbon's severity tiers, plus `stale`: a Running that can no longer be trusted.
 */
export const StatusToken = z.enum([
  'needs_you',
  'failed',
  'running',
  'stale',
  'done_unseen',
  'quiet',
]);
export type StatusToken = z.infer<typeof StatusToken>;

export type StatusSeverity = 'high' | 'medium' | 'low' | 'none';

export const STATUS_TOKEN_META: Record<StatusToken, { severity: StatusSeverity; label: string }> = {
  needs_you: { severity: 'high', label: 'Needs you' },
  failed: { severity: 'high', label: 'Failed' },
  running: { severity: 'medium', label: 'Running' },
  stale: { severity: 'medium', label: 'Stale' },
  done_unseen: { severity: 'low', label: 'Done, unseen' },
  quiet: { severity: 'none', label: 'Quiet' },
};

/** No hook, transcript or output for this long while a session claims to be thinking. */
export const SESSION_SILENT_MS = 10 * 60_000;
/** The same for a running tool, which can legitimately take much longer between events. */
export const TOOL_SILENT_MS = 20 * 60_000;
/** A shorter command finishing isn't news: only longer ones leave a Done, unseen mark. */
export const LONG_COMMAND_MS = 30_000;

/** Every session status, with the token it shows when nothing else is known. */
export const SESSION_STATUS_TOKEN: Record<SessionStatusKind, StatusToken> = {
  idle: 'quiet',
  working: 'running',
  tool: 'running',
  compacting: 'running',
  waiting_permission: 'needs_you',
  waiting_input: 'needs_you',
  error: 'failed',
  unknown: 'quiet',
  ended: 'quiet',
  interrupted: 'quiet',
};

export interface SessionTokenFacts {
  /** Subagents or background tasks still run after the turn ended. */
  background?: boolean;
  /** A finished turn this browser hasn't opened since. */
  unseen?: boolean;
  /** The event stream behind this session went quiet. */
  stale?: boolean;
}

export function sessionStatusToken(
  kind: SessionStatusKind,
  { background = false, unseen = false, stale = false }: SessionTokenFacts = {},
): StatusToken {
  const token = SESSION_STATUS_TOKEN[kind];
  const settled = kind === 'idle' || kind === 'unknown';
  if (token === 'running' || (settled && background)) return stale ? 'stale' : 'running';
  return kind === 'idle' && unseen ? 'done_unseen' : token;
}

export interface TerminalTokenFacts {
  state: TerminalState;
  /** A command is running in it. */
  running: boolean;
  /** Its last command, or the terminal itself, exited with a failure. */
  failed: boolean;
  /** A long command finished and this browser hasn't opened the terminal since. */
  unseen?: boolean;
  /** The editor window behind it is gone, or the board lost its connection. */
  stale?: boolean;
}

export function terminalStatusToken({
  state,
  running,
  failed,
  unseen = false,
  stale = false,
}: TerminalTokenFacts): StatusToken {
  if (failed) return 'failed';
  if (state === 'closed') return 'quiet';
  if (running) return stale ? 'stale' : 'running';
  return unseen ? 'done_unseen' : 'quiet';
}

/** A session that claims to be busy has been silent for longer than that state allows. */
export function sessionSilent(kind: SessionStatusKind, lastEventAt: number, now: number): boolean {
  if (SESSION_STATUS_TOKEN[kind] !== 'running') return false;
  return now - lastEventAt >= (kind === 'tool' ? TOOL_SILENT_MS : SESSION_SILENT_MS);
}

/** Marks one update may carry, and marks kept per browser (the oldest drop off). */
export const MAX_SEEN_UPDATE = 200;
export const MAX_SEEN_MARKS = 1000;

/** What this browser has opened: an item's key and when. Kept per signed-in browser. */
export const SeenMarks = z.record(z.string().min(1).max(320), z.number().int().nonnegative());
export type SeenMarks = z.infer<typeof SeenMarks>;

/** `GET /api/seen`. Anything finished before `since` was never news to this browser. */
export const SeenResponse = z.object({ since: z.number().int().nonnegative(), marks: SeenMarks });
export type SeenResponse = z.infer<typeof SeenResponse>;

/** `POST /api/seen`. */
export const SeenUpdate = z.object({
  marks: SeenMarks.refine((marks) => Object.keys(marks).length <= MAX_SEEN_UPDATE),
  /** Puts marks back as they were, for an undo; null removes one. Applied after `marks`. */
  restore: z
    .record(z.string().max(300), z.number().int().nonnegative().nullable())
    .refine((marks) => Object.keys(marks).length <= MAX_SEEN_UPDATE)
    .optional(),
});
export type SeenUpdate = z.infer<typeof SeenUpdate>;
