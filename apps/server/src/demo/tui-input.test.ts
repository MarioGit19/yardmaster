import { describe, expect, it } from 'vitest';
import { readTuiInput, TUI_PASTE_MIN } from './tui-input.js';

describe('readTuiInput', () => {
  it('submits a short line typed with its Enter', () => {
    expect(readTuiInput('', 'test\r')).toEqual({
      buffer: '',
      submitted: ['test'],
      echo: 'test\r\n',
    });
  });

  it('reads a long line with its Enter as a paste: the Enter becomes a newline', () => {
    const long = 'x'.repeat(TUI_PASTE_MIN);
    expect(readTuiInput('', `${long}\r`)).toMatchObject({ buffer: `${long}\n`, submitted: [] });
  });

  it('inserts bracketed paste literally and submits it on a lone Enter', () => {
    const pasted = readTuiInput('', '\x1b[200~one\ntwo\r\nthree\x1b[201~');
    expect(pasted).toMatchObject({ buffer: 'one\ntwo\nthree', submitted: [] });
    expect(readTuiInput(pasted.buffer, '\r').submitted).toEqual(['one\ntwo\nthree']);
  });

  it('ignores an Enter at an empty prompt and erases with DEL', () => {
    expect(readTuiInput('', '\r').submitted).toEqual([]);
    expect(readTuiInput('ab', '\x7f').buffer).toBe('a');
  });

  it('types nothing for Esc, arrow keys or Ctrl+C', () => {
    expect(readTuiInput('ab', '\x1b')).toMatchObject({ buffer: 'ab', echo: '' });
    expect(readTuiInput('ab', '\x1b[A\x03c')).toMatchObject({ buffer: 'abc', echo: 'c' });
  });
});
