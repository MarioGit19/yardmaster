import { z } from 'zod';
import { Pid, SessionId, Timestamp, TokenUsage } from './domain.js';

/**
 * One `~/.claude/sessions/<pid>.json` file, PRD §6.4. Undocumented and version-dependent:
 * only `pid` and `sessionId` are required, a malformed optional field reads as absent, and
 * every other field in the file is dropped.
 */
export const SessionRegistryEntry = z.object({
  pid: Pid,
  sessionId: SessionId,
  cwd: z.string().min(1).max(4096).optional().catch(undefined),
  status: z.string().max(64).optional().catch(undefined),
  kind: z.string().max(64).optional().catch(undefined),
  entrypoint: z.string().max(64).optional().catch(undefined),
  name: z.string().max(512).optional().catch(undefined),
});
export type SessionRegistryEntry = z.infer<typeof SessionRegistryEntry>;

/** A past session of a project, from the Agent SDK's `listSessions` (F17). */
export const SessionHistoryEntry = z.object({
  id: SessionId,
  projectId: z.string(),
  title: z.string().nullable(),
  firstPrompt: z.string().nullable(),
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  createdAt: Timestamp.nullable(),
  updatedAt: Timestamp,
  fileSize: z.number().int().nonnegative().nullable(),
  /** Known only for sessions the board has seen live; the SDK listing carries no usage. */
  tokens: TokenUsage.nullable().default(null),
});
export type SessionHistoryEntry = z.infer<typeof SessionHistoryEntry>;

/**
 * Claude Code session ids are UUIDs. Anything placed on a shell command line (`claude --resume`)
 * must match this, so a hostile id can't smuggle shell syntax into a terminal.
 */
export const RESUMABLE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
