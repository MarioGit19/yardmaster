import { describe, expect, it } from 'vitest';
import { applySgr, type Line, segmentCss, TerminalTail } from './ansi.js';

const text = (line: Line) => line.map((s) => s.text).join('');
const texts = (tail: TerminalTail) => tail.snapshot().map(text);
const ESC = '\x1b';

describe('TerminalTail', () => {
  it('keeps the last N lines plus the open one', () => {
    const tail = new TerminalTail(3);
    tail.feed('one\r\ntwo\r\nthree\r\nfour\r\nfive');
    expect(texts(tail)).toEqual(['three', 'four', 'five']);
    tail.feed('\r\n');
    expect(texts(tail)).toEqual(['three', 'four', 'five']);
  });

  it('treats a bare CR as a rewind and CRLF split across chunks as one newline', () => {
    const tail = new TerminalTail(6);
    tail.feed('progress 10%\rprogress 90%\r');
    tail.feed('\ndone\n');
    expect(texts(tail)).toEqual(['progress 90%', 'done']);
  });

  it('parses SGR colors into segments', () => {
    const tail = new TerminalTail();
    tail.feed(`${ESC}[32m✓${ESC}[39m Ready ${ESC}[1;31mfail${ESC}[0m\n`);
    const [line = []] = tail.snapshot();
    expect(line.map((s) => [s.text, s.style.fg, s.style.bold])).toEqual([
      ['✓', 'var(--st-ok)', false],
      [' Ready ', null, false],
      ['fail', 'var(--st-err)', true],
    ]);
  });

  it('carries an escape sequence cut between chunks', () => {
    const tail = new TerminalTail();
    tail.feed(`a${ESC}[3`);
    tail.feed(`6mb${ESC}`);
    tail.feed('[0mc\n');
    const [line = []] = tail.snapshot();
    expect(line.map((s) => [s.text, s.style.fg])).toEqual([
      ['a', null],
      ['b', 'var(--st-tool)'],
      ['c', null],
    ]);
  });

  it('drops cursor movement, OSC titles and stray control bytes', () => {
    const tail = new TerminalTail();
    tail.feed(`${ESC}]0;title${ESC}\\${ESC}[2K${ESC}[1Ghello${ESC}(B\x07\x00 world\n`);
    expect(texts(tail)).toEqual(['hello world']);
  });

  it('handles backspace and tabs', () => {
    const tail = new TerminalTail();
    tail.feed('abx\bc\td\n');
    expect(texts(tail)).toEqual(['abc  d']);
  });

  it('bounds the work for a huge backlog and very long lines', () => {
    const tail = new TerminalTail(2);
    const backlog = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join('\n');
    tail.feed(`${backlog}\n`);
    expect(texts(tail)).toEqual(['line 49998', 'line 49999']);
    tail.feed('x'.repeat(5_000));
    expect(text(tail.snapshot().at(-1) ?? []).length).toBe(1_000);
  });
});

describe('applySgr', () => {
  it('supports 256-color and truecolor', () => {
    const plain = applySgr(applySgr({} as never, '0'), '');
    expect(applySgr(plain, '38;5;196').fg).toBe('rgb(255 0 0)');
    expect(applySgr(plain, '38;5;2').fg).toBe('var(--st-ok)');
    expect(applySgr(plain, '48;2;10;20;30').bg).toBe('rgb(10 20 30)');
    expect(applySgr(plain, '38;5;240').fg).toBe('rgb(88 88 88)');
  });

  it('turns inverse into swapped colors', () => {
    const style = applySgr(applySgr({} as never, '0'), '41;37;1');
    expect(segmentCss({ ...style, inverse: true })).toMatchObject({
      color: 'var(--st-err)',
      backgroundColor: 'var(--text-1)',
    });
    expect(segmentCss(applySgr(style, '0'))).toBeUndefined();
  });
});
