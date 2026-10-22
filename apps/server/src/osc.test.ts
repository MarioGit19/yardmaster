import { describe, expect, it } from 'vitest';
import { createOscStripper, stripOsc633 } from './osc.js';

const ESC = '\x1b';
const BEL = '\x07';
const PROMPT_START = `${ESC}]633;A${BEL}`;
const COMMAND_LINE = `${ESC}]633;E;pnpm test;nonce-1${ESC}\\`;
const RED = `${ESC}[31m`;
const RESET = `${ESC}[0m`;

function streamed(text: string, sizes: number[]): string {
  const stripper = createOscStripper();
  let out = '';
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const size = sizes[k++ % sizes.length] as number;
    out += stripper.push(text.slice(i, i + size));
    i += size;
  }
  return out + stripper.flush();
}

describe('OSC 633 stripping', () => {
  it('removes BEL- and ST-terminated sequences and keeps ANSI', () => {
    const input = `${PROMPT_START}$ ${COMMAND_LINE}${RED}FAIL${RESET} cart.test.ts\r\n${ESC}]633;D;1${BEL}`;
    expect(stripOsc633(input)).toBe(`$ ${RED}FAIL${RESET} cart.test.ts\r\n`);
  });

  it('keeps other OSC sequences such as titles and hyperlinks', () => {
    const title = `${ESC}]0;acme-shop${BEL}`;
    const link = `${ESC}]8;;https://example.test${ESC}\\link${ESC}]8;;${ESC}\\`;
    expect(stripOsc633(`${title}${link}`)).toBe(`${title}${link}`);
  });

  it('handles sequences split at every possible boundary', () => {
    const input = `ok ${PROMPT_START}${RED}x${RESET}${COMMAND_LINE}done ${ESC}]633;P;Cwd=/home/dev/acme-shop${BEL}!`;
    const expected = `ok ${RED}x${RESET}done !`;
    for (let size = 1; size <= input.length; size++) {
      expect(streamed(input, [size])).toBe(expected);
    }
    expect(streamed(input, [1, 3, 2, 7])).toBe(expected);
  });

  it('releases a partial marker that never completes', () => {
    const stripper = createOscStripper();
    expect(stripper.push(`tail${ESC}]63`)).toBe('tail');
    expect(stripper.flush()).toBe(`${ESC}]63`);
  });

  it('passes a lone ESC through when the next chunk is not a marker', () => {
    const stripper = createOscStripper();
    expect(stripper.push(`a${ESC}`)).toBe('a');
    expect(stripper.push('[1mb')).toBe(`${ESC}[1mb`);
  });

  it('drops an unterminated sequence at end of stream', () => {
    const stripper = createOscStripper();
    expect(stripper.push(`x${ESC}]633;E;half`)).toBe('x');
    expect(stripper.flush()).toBe('');
    expect(stripper.push('y')).toBe('y');
  });
});
