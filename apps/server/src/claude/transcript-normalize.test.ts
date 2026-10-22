import { readFileSync } from 'node:fs';
import { ChatMessage } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import {
  entryUuid,
  MAX_INPUT_STRING,
  MAX_TEXT,
  normalizeEntry,
  parseTranscriptLine,
  toUsage,
  UsageTracker,
} from './transcript-normalize.js';

const FIXTURE = new URL('../../fixtures/transcripts/session.jsonl', import.meta.url);
const lines = readFileSync(FIXTURE, 'utf8').split('\n');

describe('parseTranscriptLine', () => {
  it('parses objects and rejects blank, invalid and non-object lines', () => {
    expect(parseTranscriptLine('{"type":"user"}')).toEqual({ type: 'user' });
    expect(parseTranscriptLine('   ')).toBeNull();
    expect(parseTranscriptLine('this is not json')).toBeNull();
    expect(parseTranscriptLine('[1,2]')).toBeNull();
    expect(parseTranscriptLine('42')).toBeNull();
    expect(parseTranscriptLine(lines.at(-1) as string)).toBeNull();
  });
});

describe('normalizeEntry', () => {
  const messages = lines.flatMap((line) => normalizeEntry(parseTranscriptLine(line)));

  it('normalizes the synthetic transcript, skipping unknown types, sidechains and bad lines', () => {
    expect(messages.map((m) => m.kind)).toEqual([
      'user',
      'user',
      'thinking',
      'assistant',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
    ]);
    for (const message of messages) expect(ChatMessage.safeParse(message).success).toBe(true);
  });

  it('keeps user text, meta flags and timestamps', () => {
    expect(messages[0]).toEqual({
      id: '0b1c2d3e-0000-4000-8000-000000000001:0',
      uuid: '0b1c2d3e-0000-4000-8000-000000000001',
      ts: Date.parse('2026-01-15T10:00:00.000Z'),
      kind: 'user',
      text: 'Add a badge with the item count to the cart icon',
      meta: false,
    });
    expect(messages[1]).toMatchObject({ kind: 'user', meta: true });
  });

  it('carries the message id, model and usage on assistant blocks', () => {
    expect(messages[2]).toMatchObject({
      kind: 'thinking',
      text: 'The badge lives in the header component.',
      messageId: 'msg_synthetic_01',
      model: 'claude-sonnet-5-5',
      usage: { input: 120, output: 5, cacheRead: 8000, cacheCreation: 2000 },
    });
    expect(messages[3]).toMatchObject({
      kind: 'assistant',
      text: "I'll look at the header first.",
    });
  });

  it('links tool results to their tool use by id', () => {
    expect(messages[4]).toMatchObject({
      kind: 'tool_use',
      toolUseId: 'toolu_synthetic_01',
      name: 'Read',
      input: { file_path: '/home/dev/acme-shop/src/Header.tsx' },
    });
    expect(messages[5]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'toolu_synthetic_01',
      text: 'export function Header() {}\n[image]',
      isError: false,
    });
    expect(messages[7]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'toolu_synthetic_02',
      text: '1 test failed',
      isError: true,
    });
  });

  it('accepts SDK SessionMessage entries (no timestamp)', () => {
    const [message] = normalizeEntry({
      type: 'assistant',
      uuid: 'u-1',
      session_id: 's-1',
      parent_tool_use_id: null,
      message: { id: 'msg_1', content: [{ type: 'text', text: 'hi' }] },
    });
    expect(message).toMatchObject({ kind: 'assistant', text: 'hi', ts: null, usage: null });
    const [stamped] = normalizeEntry({
      type: 'user',
      uuid: 'u-2',
      timestamp: 1_768_471_200_000,
      message: { content: 'yo' },
    });
    expect(stamped?.ts).toBe(1_768_471_200_000);
  });

  it('never throws on malformed shapes', () => {
    const bad: unknown[] = [
      null,
      42,
      'user',
      { type: 'user' },
      { type: 'user', message: { content: 7 } },
      { type: 'assistant', message: { content: 'not an array' } },
      { type: 'assistant', message: { content: [null, 1, { type: 'tool_use' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result' }] } },
      { type: 'user', timestamp: 'yesterday', message: { content: '' } },
    ];
    for (const entry of bad) expect(normalizeEntry(entry)).toEqual([]);
  });

  it('clips oversized text and tool input strings', () => {
    const big = 'x'.repeat(MAX_TEXT + 10);
    const [user] = normalizeEntry({ type: 'user', uuid: 'u', message: { content: big } });
    expect(user?.kind === 'user' && user.text.length).toBe(MAX_TEXT);
    const [tool] = normalizeEntry({
      type: 'assistant',
      uuid: 'a',
      message: {
        content: [{ type: 'tool_use', id: 't', name: 'Write', input: { content: big, n: 1 } }],
      },
    });
    const input = tool?.kind === 'tool_use' ? (tool.input as { content: string; n: number }) : null;
    expect(input?.content.length).toBe(MAX_INPUT_STRING);
    expect(input?.n).toBe(1);
  });

  it('reads entry uuids', () => {
    expect(entryUuid({ uuid: 'abc' })).toBe('abc');
    expect(entryUuid({ uuid: '' })).toBeNull();
    expect(entryUuid(null)).toBeNull();
  });
});

describe('UsageTracker', () => {
  it('counts the latest usage per message and tracks context size', () => {
    const tracker = new UsageTracker();
    expect(tracker.contextTokens).toBeNull();
    const u = (input: number, output: number, cacheRead = 0, cacheCreation = 0) => ({
      input,
      output,
      cacheRead,
      cacheCreation,
    });
    expect(tracker.add('m1', u(100, 5, 1000, 50))).toBe(true);
    expect(tracker.add('m1', u(100, 40, 1000, 50))).toBe(true);
    expect(tracker.add('m1', u(100, 40, 1000, 50))).toBe(false);
    expect(tracker.add('m2', u(10, 20, 2000, 0))).toBe(true);
    expect(tracker.tokens).toEqual(u(110, 60, 3000, 50));
    expect(tracker.contextTokens).toBe(10 + 20 + 2000);
  });

  it('maps API usage, tolerating missing or bad counts', () => {
    expect(toUsage({ input_tokens: 3, output_tokens: -1, cache_read_input_tokens: 'x' })).toEqual({
      input: 3,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });
    expect(toUsage(undefined)).toBeNull();
  });
});
