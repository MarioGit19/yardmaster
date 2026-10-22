import { z } from 'zod';
import { SessionId, Timestamp, TokenUsage } from './domain.js';

// Normalized Claude transcript entries (PRD §6.3, F5). One entry per content block, so the
// stream stays append-only while an assistant turn arrives block by block.

const Base = {
  /** Unique within the session: `<line uuid>:<block index>`. */
  id: z.string().min(1).max(300),
  /** Transcript line uuid. */
  uuid: z.string().max(256).nullable(),
  ts: Timestamp.nullable(),
};

/** Assistant entries of one API message share `messageId`; the usage is the latest seen for it. */
const AssistantBase = {
  ...Base,
  messageId: z.string().max(256).nullable(),
  model: z.string().max(128).nullable(),
  usage: TokenUsage.nullable(),
};

export const ChatUserText = z.object({
  ...Base,
  kind: z.literal('user'),
  text: z.string(),
  /** Injected by Claude Code (command caveats, reminders), not typed by the user. */
  meta: z.boolean(),
});
export const ChatAssistantText = z.object({
  ...AssistantBase,
  kind: z.literal('assistant'),
  text: z.string(),
});
export const ChatThinking = z.object({
  ...AssistantBase,
  kind: z.literal('thinking'),
  text: z.string(),
});
export const ChatToolUse = z.object({
  ...AssistantBase,
  kind: z.literal('tool_use'),
  toolUseId: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  input: z.unknown(),
});
export const ChatToolResult = z.object({
  ...Base,
  kind: z.literal('tool_result'),
  /** The `tool_use` entry this answers. */
  toolUseId: z.string().min(1).max(256),
  text: z.string(),
  isError: z.boolean(),
});

export const ChatMessage = z.discriminatedUnion('kind', [
  ChatUserText,
  ChatAssistantText,
  ChatThinking,
  ChatToolUse,
  ChatToolResult,
]);
export type ChatMessage = z.infer<typeof ChatMessage>;
export type ChatMessageKind = ChatMessage['kind'];

/** Each `stream.data` chunk of a `transcript:<sessionId>` stream is one JSON `ChatMessage`. */
export const TRANSCRIPT_STREAM_PREFIX = 'transcript:';

export const transcriptStreamId = (sessionId: string) =>
  `${TRANSCRIPT_STREAM_PREFIX}${sessionId}` as const;

/** The session id of a transcript stream, or null for any other stream. */
export function sessionIdFromStream(streamId: string): string | null {
  if (!streamId.startsWith(TRANSCRIPT_STREAM_PREFIX)) return null;
  const parsed = SessionId.safeParse(streamId.slice(TRANSCRIPT_STREAM_PREFIX.length));
  return parsed.success ? parsed.data : null;
}

/** Parses one transcript stream chunk. Never throws. */
export function decodeChatMessage(chunk: string): ChatMessage | null {
  try {
    const parsed = ChatMessage.safeParse(JSON.parse(chunk));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
