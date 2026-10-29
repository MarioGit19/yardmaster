import { MASK } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { redactItem } from '../claude/MessageList.js';
import type { TranscriptRow } from '../claude/transcript.js';
import { maskLine } from '../lanes/TerminalPeek.js';
import { reveal } from './reveal.js';

const TOKEN = `${'gh'}p_${'k2M4n6P8q0'.repeat(4)}`;
const base = { id: 'r1', ts: null } as const;

describe('transcript rows', () => {
  it('masks message text', () => {
    const row: TranscriptRow = { ...base, kind: 'assistant', text: `Use ${TOKEN} here` };
    expect(redactItem(row)).toEqual({ ...row, text: `Use ghp_${MASK} here` });
  });

  it('masks tool input and result', () => {
    const row: TranscriptRow = {
      ...base,
      kind: 'tool',
      toolUseId: 'tu1',
      name: 'Bash',
      input: { command: 'cat .env' },
      result: { text: 'PORT=3000\nAPI_KEY=abc123', isError: false },
    };
    const masked = redactItem(row);
    expect(masked).toEqual({
      ...row,
      result: { text: `PORT=3000\nAPI_KEY=${MASK}`, isError: false },
    });
    const write = {
      ...row,
      input: { file_path: '/home/dev/acme-shop/.env', content: `T=${TOKEN}` },
    };
    expect(redactItem(write)).toMatchObject({ input: { content: `T=ghp_${MASK}` } });
  });

  it('returns the same row when there is nothing to mask', () => {
    const row: TranscriptRow = { ...base, kind: 'user', text: 'run the tests' };
    expect(redactItem(row)).toBe(row);
    const running: TranscriptRow = {
      ...base,
      kind: 'tool',
      toolUseId: 'tu2',
      name: 'Read',
      input: { file_path: '/home/dev/acme-shop/a.ts' },
      result: null,
    };
    expect(redactItem(running)).toBe(running);
  });
});

describe('terminal peek lines', () => {
  const style = {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };

  it('masks a secret split over styled segments', () => {
    const line = [
      { text: 'token ', style },
      { text: TOKEN.slice(0, 10), style: { ...style, bold: true } },
      { text: TOKEN.slice(10), style },
    ];
    expect(
      maskLine(line)
        .map((s) => s.text)
        .join(''),
    ).toBe(`token ghp_${MASK}`);
  });

  it('keeps an ordinary line as it is', () => {
    const line = [{ text: 'done in 1.2s', style }];
    expect(maskLine(line)).toBe(line);
  });
});

describe('reveal', () => {
  it('toggles a block and notifies', () => {
    let calls = 0;
    const off = reveal.subscribe(() => calls++);
    reveal.toggle('row:x');
    expect(reveal.has('row:x')).toBe(true);
    reveal.toggle('row:x');
    expect(reveal.has('row:x')).toBe(false);
    off();
    expect(calls).toBe(2);
  });
});
