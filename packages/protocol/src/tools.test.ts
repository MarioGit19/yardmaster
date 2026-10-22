import { describe, expect, it } from 'vitest';
import { parseToolCall } from './tools.js';

describe('parseToolCall', () => {
  it('parses the built-in tools', () => {
    expect(parseToolCall('Bash', { command: 'pnpm test', description: 'Run tests' })).toEqual({
      kind: 'bash',
      command: 'pnpm test',
      description: 'Run tests',
      background: false,
    });
    expect(
      parseToolCall('Edit', { file_path: '/home/dev/a.ts', old_string: 'a', new_string: 'b' }),
    ).toEqual({
      kind: 'edit',
      tool: 'Edit',
      filePath: '/home/dev/a.ts',
      edits: [{ oldString: 'a', newString: 'b', replaceAll: false }],
    });
    expect(
      parseToolCall('MultiEdit', {
        file_path: '/home/dev/a.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd', replace_all: true },
        ],
      }),
    ).toMatchObject({ kind: 'edit', tool: 'MultiEdit', edits: [{}, { replaceAll: true }] });
    expect(parseToolCall('Write', { file_path: '/home/dev/a.ts', content: 'x' })).toMatchObject({
      kind: 'write',
    });
    expect(parseToolCall('Read', { file_path: '/home/dev/a.ts', offset: 10 })).toEqual({
      kind: 'read',
      filePath: '/home/dev/a.ts',
      offset: 10,
      limit: null,
    });
    expect(parseToolCall('Grep', { pattern: 'foo', glob: '*.ts' })).toMatchObject({
      kind: 'grep',
      glob: '*.ts',
      path: null,
    });
    expect(parseToolCall('Glob', { pattern: '**/*.ts' })).toMatchObject({ kind: 'glob' });
    expect(
      parseToolCall('TodoWrite', {
        todos: [{ content: 'Read', status: 'completed', activeForm: 'Reading' }],
      }),
    ).toEqual({
      kind: 'todo',
      todos: [{ content: 'Read', status: 'completed', activeForm: 'Reading' }],
    });
    expect(parseToolCall('Agent', { description: 'Find callers', prompt: 'p' })).toEqual({
      kind: 'task',
      description: 'Find callers',
      prompt: 'p',
      agent: null,
    });
    expect(parseToolCall('WebFetch', { url: 'https://example.com' })).toMatchObject({
      kind: 'fetch',
      prompt: null,
    });
    expect(parseToolCall('WebSearch', { query: 'backoff' })).toEqual({
      kind: 'search',
      query: 'backoff',
    });
  });

  it('keeps unknown fields from newer Claude Code versions', () => {
    expect(parseToolCall('Bash', { command: 'ls', timeout: 1000, sandbox: true }).kind).toBe(
      'bash',
    );
  });

  it('falls back to the generic view for unknown tools and malformed input', () => {
    expect(parseToolCall('mcp__tracker__create_ticket', { title: 'x' })).toEqual({
      kind: 'other',
    });
    expect(parseToolCall('Bash', { command: 42 })).toEqual({ kind: 'other' });
    expect(parseToolCall('Edit', null)).toEqual({ kind: 'other' });
    expect(parseToolCall('TodoWrite', { todos: [{ content: 'x', status: 'later' }] })).toEqual({
      kind: 'other',
    });
    expect(parseToolCall('MultiEdit', { file_path: '/a', edits: [] })).toEqual({ kind: 'other' });
  });
});
