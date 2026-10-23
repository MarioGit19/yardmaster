import { type ChatMessage, decodeChatMessage } from '@c-board/protocol';

interface RowBase {
  /** The `ChatMessage` id; stable, so it keys virtual rows. */
  id: string;
  ts: number | null;
}

export type TranscriptRow =
  | (RowBase & { kind: 'user'; text: string })
  | (RowBase & { kind: 'assistant'; text: string })
  | (RowBase & { kind: 'thinking'; text: string })
  | (RowBase & {
      kind: 'tool';
      toolUseId: string;
      name: string;
      input: unknown;
      /** Null while the tool is running. */
      result: { text: string; isError: boolean } | null;
    });

export type ToolRow = Extract<TranscriptRow, { kind: 'tool' }>;

/**
 * Folds a transcript stream into display rows: one per user, assistant or thinking block, and
 * one per tool call with its result attached. Injected user messages are left out. Rows are
 * immutable, so a changed row is a new object and unchanged rows keep their identity.
 */
export class TranscriptModel {
  private list: TranscriptRow[] = [];
  private readonly ids = new Set<string>();
  private readonly toolIndex = new Map<string, number>();

  get rows(): readonly TranscriptRow[] {
    return this.list;
  }

  /** Adds raw stream chunks. Returns whether any row changed. */
  pushChunks(chunks: readonly string[]): boolean {
    const messages: ChatMessage[] = [];
    for (const chunk of chunks) {
      const message = decodeChatMessage(chunk);
      if (message) messages.push(message);
    }
    return this.push(messages);
  }

  push(messages: readonly ChatMessage[]): boolean {
    let next: TranscriptRow[] | null = null;
    const rows = () => {
      next ??= [...this.list];
      return next;
    };
    for (const m of messages) {
      // Replays after a reconnect resend what we already have.
      if (this.ids.has(m.id)) continue;
      this.ids.add(m.id);
      switch (m.kind) {
        case 'user':
          if (m.meta || m.text.trim() === '') break;
          rows().push({ kind: 'user', id: m.id, ts: m.ts, text: m.text });
          break;
        case 'assistant':
        case 'thinking':
          if (m.text.trim() === '') break;
          rows().push({ kind: m.kind, id: m.id, ts: m.ts, text: m.text });
          break;
        case 'tool_use':
          this.toolIndex.set(m.toolUseId, rows().length);
          rows().push({
            kind: 'tool',
            id: m.id,
            ts: m.ts,
            toolUseId: m.toolUseId,
            name: m.name,
            input: m.input,
            result: null,
          });
          break;
        case 'tool_result': {
          const index = this.toolIndex.get(m.toolUseId);
          const row = index === undefined ? undefined : rows()[index];
          // A result whose call was dropped from the buffer has nothing to attach to.
          if (row?.kind !== 'tool') break;
          rows()[index as number] = { ...row, result: { text: m.text, isError: m.isError } };
          break;
        }
      }
    }
    if (next === null) return false;
    this.list = next;
    return true;
  }
}

/**
 * The live text to show after the last row while Claude is still writing it, or null. Text set
 * before the last user message belongs to an earlier turn, so it never shows under a new one.
 */
export function streamingTail(
  rows: readonly TranscriptRow[],
  last: { text: string | null; at: number | null },
  working: boolean,
): string | null {
  const { text, at } = last;
  if (!working || !text?.trim()) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] as TranscriptRow;
    if (row.kind === 'user') {
      if (at !== null && row.ts !== null && at < row.ts) return null;
      break;
    }
    // Already written to the transcript: nothing left to stream.
    if (row.kind === 'assistant' && row.text === text) return null;
  }
  return text;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/** One line describing a tool call: its path, command, pattern, URL or description. */
export function toolSummary(name: string, input: unknown, cwd?: string): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const path = str(o.file_path) ?? str(o.notebook_path) ?? str(o.path);
  const relative = path && cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  switch (name) {
    case 'Bash':
      return str(o.command) ?? '';
    case 'Grep':
    case 'Glob':
      return str(o.pattern) ?? '';
    case 'WebFetch':
      return str(o.url) ?? '';
    case 'WebSearch':
      return str(o.query) ?? '';
    case 'Task':
    case 'Agent':
      return str(o.description) ?? '';
    default:
      return relative ?? str(o.description) ?? str(o.command) ?? '';
  }
}
