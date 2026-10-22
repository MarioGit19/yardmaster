import { describe, expect, it } from 'vitest';
import {
  bashExitCode,
  bashOutput,
  editStartLine,
  extensionOf,
  globCount,
  grepCount,
  numberedLines,
  pathParts,
  readExtent,
  stripAnsi,
  toolLabel,
  urlParts,
  urlsIn,
} from './results.js';

const ESC = String.fromCharCode(27);

describe('tool results', () => {
  it('reads Bash exit codes and output', () => {
    expect(bashExitCode(null)).toBeNull();
    expect(bashExitCode({ text: 'ok', isError: false })).toBe(0);
    expect(bashExitCode({ text: 'Exit code 2\nboom', isError: true })).toBe(2);
    expect(bashExitCode({ text: 'Error: Exit code 127\n', isError: true })).toBe(127);
    expect(bashExitCode({ text: 'killed', isError: true })).toBe(1);
    expect(bashOutput(`Exit code 1\n${ESC}[31mFAIL${ESC}[0m  a.test.ts\n\n`)).toBe(
      'FAIL  a.test.ts',
    );
    expect(stripAnsi(`${ESC}]0;title\u0007plain`)).toBe('plain');
  });

  it('parses numbered snippets and finds where an edit landed', () => {
    const snippet = '    40\tconst a = 1;\n    41\tconst b = 2;\n    42→const c = 3;';
    expect(numberedLines(snippet)?.map((l) => l.no)).toEqual([40, 41, 42]);
    expect(numberedLines('just text')).toBeNull();
    expect(editStartLine(`The file was updated:\n${snippet}`, 'const b = 2;\nconst c = 3;')).toBe(
      41,
    );
    expect(editStartLine(snippet, '\nconst c = 3;')).toBe(41);
    expect(editStartLine(snippet, 'missing')).toBeNull();
    expect(editStartLine('    1\tx\n    2\tx', 'x')).toBeNull();
  });

  it('summarizes Read, Grep and Glob results', () => {
    expect(readExtent('     1\ta\n     2\tb')).toBe('2 lines');
    expect(readExtent('    40\ta\n    41\tb')).toBe('lines 40–41');
    expect(readExtent('File does not exist.')).toBeNull();
    expect(grepCount('Found 3 files\na\nb\nc')).toBe('3 files');
    expect(grepCount('No matches found')).toBe('no matches');
    expect(grepCount('a.ts:1:x\nb.ts:2:y')).toBe('2 lines');
    expect(globCount('/a\n/b')).toBe('2 files');
    expect(globCount('No files found')).toBe('no files');
  });

  it('pulls links out of web results', () => {
    const text =
      'Links: [{"title":"A","url":"https://example.com/a"},{"url":"https://example.org/b?q=1"}] see https://example.com/a.';
    expect(urlsIn(text)).toEqual(['https://example.com/a', 'https://example.org/b?q=1']);
    expect(urlParts('https://www.example.com/docs?x=1')).toEqual({
      host: 'example.com',
      rest: '/docs?x=1',
    });
    expect(urlParts('javascript:alert(1)')).toBeNull();
    expect(urlParts('not a url')).toBeNull();
  });

  it('labels tools and paths', () => {
    expect(toolLabel('mcp__tracker__create_ticket')).toBe('tracker · create_ticket');
    expect(toolLabel('Bash')).toBe('Bash');
    expect(pathParts('/home/dev/acme-shop/src/cart/a.ts', '/home/dev/acme-shop')).toEqual({
      dir: 'src/cart/',
      base: 'a.ts',
    });
    expect(pathParts('README.md')).toEqual({ dir: '', base: 'README.md' });
    expect(extensionOf('/a/b.test.tsx')).toBe('tsx');
    expect(extensionOf('/a/.env')).toBeNull();
  });
});
