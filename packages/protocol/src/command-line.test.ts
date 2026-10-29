import { describe, expect, it } from 'vitest';
import { isSafeCommandLine, visibleCommandLine } from './command-line.js';

describe('isSafeCommandLine', () => {
  it('takes ordinary command lines, tabs and non-Latin text', () => {
    for (const line of ['pnpm dev', 'printf "a\tb"', 'echo "héllo ✓ 日本"', 'echo 👨‍👩‍👧']) {
      expect(isSafeCommandLine(line)).toBe(true);
    }
  });

  it('refuses control characters and bidi overrides', () => {
    for (const line of [
      'ls\nrm -rf ~',
      'ls\r',
      'echo \x1b[8mhidden',
      'echo \x07',
      'a\x7f',
      'a\x9bb',
      'echo ‮)txt.exe',
      'echo ⁦x⁩',
    ]) {
      expect(isSafeCommandLine(line)).toBe(false);
    }
  });
});

describe('visibleCommandLine', () => {
  it('shows every control, bidi and zero-width character', () => {
    expect(visibleCommandLine('echo ok\x1b[2K\rrm -rf ~\n')).toBe('echo ok␛[2K␍rm -rf ~␊');
    expect(visibleCommandLine('a\x00b\x7fc\x9bd')).toBe('a␀b␡c<U+009B>d');
    expect(visibleCommandLine('x‮y​z﻿')).toBe('x<U+202E>y<U+200B>z<U+FEFF>');
  });

  it('leaves ordinary text, tabs and emoji joiners alone', () => {
    for (const line of ['pnpm dev', 'printf "a\tb"', 'echo 👨‍👩‍👧']) {
      expect(visibleCommandLine(line)).toBe(line);
    }
  });
});
