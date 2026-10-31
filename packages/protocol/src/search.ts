import { z } from 'zod';
import { ProjectId, SessionId, Timestamp } from './domain.js';
import { ChatMessage } from './transcript.js';

// Search across every Claude transcript: the local full-text index and its routes (F17b).

/** `all`, or where a session stands now: on the board, finished, or archived. */
export const SEARCH_STATUSES = ['all', 'live', 'finished', 'archived'] as const;
export const SearchStatus = z.enum(SEARCH_STATUSES);
export type SearchStatus = z.infer<typeof SearchStatus>;

/** Size limit choices for the index, in MB (Settings). */
export const SEARCH_MAX_MB = [100, 250, 500, 1000] as const;
export const DEFAULT_SEARCH_MAX_MB = 500;
export const SearchMaxMb = z.literal(SEARCH_MAX_MB);
export type SearchMaxMb = z.infer<typeof SearchMaxMb>;

export const SEARCH_QUERY_MAX = 200;
export const SEARCH_LIMIT_MAX = 100;
export const DEFAULT_SEARCH_LIMIT = 40;

/** `GET /api/search` query string. */
export const SearchRequest = z.object({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX),
  projectId: ProjectId.optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  status: SearchStatus.default('all'),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).default(DEFAULT_SEARCH_LIMIT),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

/** A stretch of a snippet; `hit` marks the words that matched. Plain text, never markup. */
export const SearchRun = z.object({ text: z.string(), hit: z.boolean() });
export type SearchRun = z.infer<typeof SearchRun>;

export const SearchHit = z.object({
  sessionId: SessionId,
  /** The `ChatMessage` id, for opening the transcript at it. */
  messageId: z.string().min(1).max(300),
  kind: z.enum(['user', 'assistant', 'tool_use', 'tool_result']),
  ts: Timestamp.nullable(),
  title: z.string(),
  /** Null when the project isn't on the board any more, or never was. */
  projectId: ProjectId.nullable(),
  projectName: z.string().nullable(),
  state: SearchStatus.exclude(['all']),
  snippet: z.array(SearchRun),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchResponse = z.object({
  hits: z.array(SearchHit),
  /** More results than `limit` were found. */
  more: z.boolean(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

/** `GET /api/search/index`: what Settings shows. */
export const SearchIndexStatus = z.object({
  /** A pass over the transcripts is running. */
  indexing: z.boolean(),
  sessions: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  /** About how much of `board.db` the index takes. */
  bytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive(),
  /** Sessions dropped, oldest first, to stay under the limit. */
  trimmed: z.number().int().nonnegative(),
  lastIndexedAt: Timestamp.nullable(),
});
export type SearchIndexStatus = z.infer<typeof SearchIndexStatus>;

/** `GET /api/search/sessions/:sessionId` query string. */
export const SearchTranscriptRequest = z.object({
  around: z.string().min(1).max(300).optional(),
});

/** Part of a session's transcript, around a message or at its end. */
export const SearchTranscriptResponse = z.object({
  sessionId: SessionId,
  title: z.string(),
  projectId: ProjectId.nullable(),
  projectName: z.string().nullable(),
  cwd: z.string().nullable(),
  state: SearchStatus.exclude(['all']),
  /** Older or newer messages exist outside `messages`. */
  clipped: z.boolean(),
  messages: z.array(ChatMessage),
});
export type SearchTranscriptResponse = z.infer<typeof SearchTranscriptResponse>;
