import { describe, expect, it } from 'vitest';
import {
  createMarkerParser,
  parseMarker,
  type ShellToken,
  unescapeMarkerValue,
} from './shell-markers.js';

const osc = (body: string, end = '\x07') => `\x1b]${body}${end}`;

/** Feeds `chunks` one by one and joins adjacent text, so the split points don't matter. */
function parse(chunks: string[]): ShellToken[] {
  const parser = createMarkerParser();
  const tokens: ShellToken[] = [];
  for (const chunk of [...chunks.flatMap((c) => parser.push(c)), { text: parser.flush() }]) {
    const last = tokens.at(-1);
    if ('text' in chunk) {
      if (chunk.text === '') continue;
      if (last && 'text' in last) last.text += chunk.text;
      else tokens.push({ ...chunk });
    } else tokens.push(chunk);
  }
  return tokens;
}

const STREAM = [
  osc('633;P;Cwd=/home/dev/acme-shop'),
  osc('133;A'),
  '\x1b[36macme-shop\x1b[0m $ echo hi\r\n',
  osc('633;E;echo hi\\x3b ok'),
  osc('133;C'),
  'hi\r\n',
  osc('133;D;0', '\x1b\\'),
  osc('0;window title'),
  osc('7;file://devbox/home/dev/acme%20shop'),
].join('');

const EXPECTED: ShellToken[] = [
  { marker: { kind: 'cwd', cwd: '/home/dev/acme-shop' } },
  { marker: { kind: 'prompt' } },
  { text: '\x1b[36macme-shop\x1b[0m $ echo hi\r\n' },
  { marker: { kind: 'commandLine', commandLine: 'echo hi; ok' } },
  { marker: { kind: 'executed' } },
  { text: 'hi\r\n' },
  { marker: { kind: 'finished', exitCode: 0 } },
  // Other OSC sequences (a title here) stay in the text for xterm.
  { text: osc('0;window title') },
  { marker: { kind: 'cwd', cwd: '/home/dev/acme shop' } },
];

describe('createMarkerParser', () => {
  it('splits a stream into text and markers, in order', () => {
    expect(parse([STREAM])).toEqual(EXPECTED);
  });

  it('gives the same result however the stream is split', () => {
    for (let at = 1; at < STREAM.length; at++) {
      expect(parse([STREAM.slice(0, at), STREAM.slice(at)])).toEqual(EXPECTED);
    }
    expect(parse([...STREAM])).toEqual(EXPECTED);
  });

  it('drops unknown 133/633 letters without a trace', () => {
    expect(parse([`a${osc('633;X;whatever')}b${osc('133;B')}c`])).toEqual([
      { text: 'ab' },
      { marker: { kind: 'input' } },
      { text: 'c' },
    ]);
  });

  it('passes other escape sequences and a lone ESC through', () => {
    const text = '\x1b[2J\x1b[H\x1b]8;;https://example.test\x07link\x1b]8;;\x07 \x1b';
    expect(parse([text])).toEqual([{ text }]);
  });

  it('gives up on an unterminated marker that never ends', () => {
    const junk = `\x1b]133;${'x'.repeat(9000)}`;
    expect(parse([junk.slice(0, 4000), junk.slice(4000)])).toEqual([{ text: junk }]);
  });
});

describe('parseMarker', () => {
  it('reads exit codes, and none when the shell gave none', () => {
    expect(parseMarker('133;D;130')).toEqual({ kind: 'finished', exitCode: 130 });
    expect(parseMarker('633;D')).toEqual({ kind: 'finished', exitCode: null });
    expect(parseMarker('133;D;oops')).toEqual({ kind: 'finished', exitCode: null });
  });

  it("ignores what isn't a cwd", () => {
    expect(parseMarker('633;P;Shell=zsh')).toBeNull();
    expect(parseMarker('7;https://example.test/')).toBeNull();
    expect(parseMarker('7;not a url')).toBeNull();
  });
});

describe('unescapeMarkerValue', () => {
  it('undoes backslash and hex escapes', () => {
    expect(unescapeMarkerValue('a\\\\b\\x3bc\\x0ad\\q')).toBe('a\\b;c\nd\\q');
  });
});
