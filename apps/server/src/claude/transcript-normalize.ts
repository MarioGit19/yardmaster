import {
  type ChatMessage,
  parseTaskNotifications,
  type TaskNotification,
  type TokenUsage,
} from '@yardmaster/protocol';
import { z } from 'zod';

// Defensive normalization of Claude Code transcript lines (PRD §6.3). The format is
// undocumented: only `user`/`assistant` lines with known content blocks are read, and
// anything else is skipped without throwing.

export const MAX_TEXT = 100_000;
/** Write and Edit inputs can carry whole files. */
export const MAX_INPUT_STRING = 32 * 1024;

/** A transcript line or an SDK `SessionMessage`; both carry `type`, `uuid` and `message`. */
const RawEntry = z.looseObject({
  type: z.string(),
  uuid: z.string().max(256).optional(),
  timestamp: z.unknown().optional(),
  isMeta: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  message: z.unknown(),
});
type RawEntry = z.infer<typeof RawEntry>;

const Count = z.number().int().nonnegative().catch(0);
const Usage = z.looseObject({
  input_tokens: Count.optional(),
  output_tokens: Count.optional(),
  cache_read_input_tokens: Count.optional(),
  cache_creation_input_tokens: Count.optional(),
});

const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const ThinkingBlock = z.looseObject({ type: z.literal('thinking'), thinking: z.string() });
const ToolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  input: z.unknown(),
});
const ToolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1).max(256),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});

const UserMessage = z.looseObject({ content: z.union([z.string(), z.array(z.unknown())]) });
const AssistantMessage = z.looseObject({
  id: z.string().max(256).optional(),
  model: z.string().max(128).optional(),
  content: z.array(z.unknown()),
  usage: z.unknown().optional(),
});

/** Background-task completions a user line reports (`<task-notification>` blocks). */
export function taskNotificationsOf(raw: unknown): TaskNotification[] {
  const entry = RawEntry.safeParse(raw);
  if (!entry.success || entry.data.type !== 'user') return [];
  const message = UserMessage.safeParse(entry.data.message);
  if (!message.success) return [];
  const { content } = message.data;
  if (typeof content === 'string') return parseTaskNotifications(content);
  return content.flatMap((block) => {
    const text = TextBlock.safeParse(block);
    return text.success ? parseTaskNotifications(text.data.text) : [];
  });
}

/** Parses one JSONL line. Returns null for blank, invalid or non-object lines. */
export function parseTranscriptLine(line: string): unknown {
  const text = line.trim();
  if (text === '') return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The uuid of a raw entry, used to de-duplicate SDK history against the live tail. */
export function entryUuid(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const uuid = (raw as { uuid?: unknown }).uuid;
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : null;
}

const CustomTitleEntry = z.looseObject({
  type: z.literal('custom-title'),
  customTitle: z.string().max(512),
});

/** The name a `/rename` line gives the session, or null for any other line. */
export function customTitleOf(raw: unknown): string | null {
  const parsed = CustomTitleEntry.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.customTitle.replace(/\s+/g, ' ').trim() || null;
}

const BranchEntry = z.looseObject({ gitBranch: z.string().min(1).max(256) });

/** The branch a transcript line was written on; a detached HEAD names none. */
export function gitBranchOf(raw: unknown): string | null {
  const parsed = BranchEntry.safeParse(raw);
  if (!parsed.success || parsed.data.gitBranch === 'HEAD') return null;
  return parsed.data.gitBranch;
}

/**
 * Normalizes one raw entry into chat messages (one per content block).
 * Unknown line types, sidechain lines and unknown blocks yield nothing.
 */
export function normalizeEntry(raw: unknown): ChatMessage[] {
  const parsed = RawEntry.safeParse(raw);
  if (!parsed.success) return [];
  const entry = parsed.data;
  if (entry.isSidechain === true) return [];
  if (entry.type === 'user') return normalizeUser(entry);
  if (entry.type === 'assistant') return normalizeAssistant(entry);
  return [];
}

function normalizeUser(entry: RawEntry): ChatMessage[] {
  const message = UserMessage.safeParse(entry.message);
  if (!message.success) return [];
  const uuid = entry.uuid ?? null;
  const base = (index: number) => ({ id: entryId(entry, index), uuid, ts: timestamp(entry) });
  const meta = entry.isMeta === true;
  const { content } = message.data;
  if (typeof content === 'string') {
    return content === '' ? [] : [{ ...base(0), kind: 'user', text: clip(content), meta }];
  }

  const out: ChatMessage[] = [];
  content.forEach((block, index) => {
    const text = TextBlock.safeParse(block);
    if (text.success) {
      out.push({ ...base(index), kind: 'user', text: clip(text.data.text), meta });
      return;
    }
    const result = ToolResultBlock.safeParse(block);
    if (result.success) {
      out.push({
        ...base(index),
        kind: 'tool_result',
        toolUseId: result.data.tool_use_id,
        text: clip(resultText(result.data.content)),
        isError: result.data.is_error === true,
      });
    }
  });
  return out;
}

function normalizeAssistant(entry: RawEntry): ChatMessage[] {
  const message = AssistantMessage.safeParse(entry.message);
  if (!message.success) return [];
  const { id, model, content, usage } = message.data;
  const base = (index: number) => ({
    id: entryId(entry, index),
    uuid: entry.uuid ?? null,
    ts: timestamp(entry),
    messageId: id ?? null,
    model: model ?? null,
    usage: toUsage(usage),
  });

  const out: ChatMessage[] = [];
  content.forEach((block, index) => {
    const text = TextBlock.safeParse(block);
    if (text.success) {
      out.push({ ...base(index), kind: 'assistant', text: clip(text.data.text) });
      return;
    }
    const thinking = ThinkingBlock.safeParse(block);
    if (thinking.success) {
      out.push({ ...base(index), kind: 'thinking', text: clip(thinking.data.thinking) });
      return;
    }
    const tool = ToolUseBlock.safeParse(block);
    if (tool.success) {
      out.push({
        ...base(index),
        kind: 'tool_use',
        toolUseId: tool.data.id,
        name: tool.data.name,
        input: clipInput(tool.data.input),
      });
    }
  });
  return out;
}

/** `assistant.message.usage` in our shape, or null when absent. */
export function toUsage(raw: unknown): TokenUsage | null {
  const usage = Usage.safeParse(raw);
  if (!usage.success) return null;
  return {
    input: usage.data.input_tokens ?? 0,
    output: usage.data.output_tokens ?? 0,
    cacheRead: usage.data.cache_read_input_tokens ?? 0,
    cacheCreation: usage.data.cache_creation_input_tokens ?? 0,
  };
}

function entryId(entry: RawEntry, index: number): string {
  // Lines without a uuid are rare; the message id keeps their ids stable at least.
  const key = entry.uuid ?? (entry.message as { id?: unknown } | null)?.id;
  return `${typeof key === 'string' ? key.slice(0, 256) : 'line'}:${index}`;
}

function timestamp(entry: RawEntry): number | null {
  const raw = entry.timestamp;
  const ms = typeof raw === 'string' ? Date.parse(raw) : typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : null;
}

/** `tool_result.content` is a string or a list of blocks; images become a placeholder. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const text = TextBlock.safeParse(block);
    if (text.success) parts.push(text.data.text);
    else if ((block as { type?: unknown } | null)?.type === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clipInput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return clip(value, MAX_INPUT_STRING);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= 8) return null;
  if (Array.isArray(value)) return value.map((item) => clipInput(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '__proto__')
      .map(([key, item]) => [key, clipInput(item, depth + 1)]),
  );
}

/**
 * Session token totals from assistant usage. Claude Code writes one line per content
 * block, each repeating its message's usage, so totals count the latest usage per message.
 */
export class UsageTracker {
  private readonly perMessage = new Map<string, TokenUsage>();
  private totals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  private latest: TokenUsage | null = null;

  get tokens(): TokenUsage {
    return { ...this.totals };
  }

  /** Approximate context size: everything the latest request read, plus what it wrote. */
  get contextTokens(): number | null {
    const u = this.latest;
    return u === null ? null : u.input + u.cacheRead + u.cacheCreation + u.output;
  }

  /** Records a message's usage. Returns whether the totals changed. */
  add(key: string, usage: TokenUsage): boolean {
    const before = this.perMessage.get(key);
    this.perMessage.set(key, usage);
    this.latest = usage;
    if (before && sameUsage(before, usage)) return false;
    const t = this.totals;
    this.totals = {
      input: t.input + usage.input - (before?.input ?? 0),
      output: t.output + usage.output - (before?.output ?? 0),
      cacheRead: t.cacheRead + usage.cacheRead - (before?.cacheRead ?? 0),
      cacheCreation: t.cacheCreation + usage.cacheCreation - (before?.cacheCreation ?? 0),
    };
    return true;
  }
}

function sameUsage(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheCreation === b.cacheCreation
  );
}
