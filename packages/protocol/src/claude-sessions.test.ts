import { describe, expect, it } from 'vitest';
import {
  RESUMABLE_SESSION_ID,
  SessionHistoryEntry,
  SessionRegistryEntry,
} from './claude-sessions.js';

describe('SessionRegistryEntry', () => {
  it('keeps only the documented fields', () => {
    const entry = SessionRegistryEntry.parse({
      pid: 4242,
      sessionId: '6f1c2a9e-0d3b-4c55-9a77-1b2c3d4e5f60',
      cwd: '/home/dev/acme-shop',
      status: 'busy',
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'refactor cart',
      messagingSocketPath: '/tmp/socket',
      version: '9.9.9',
    });
    expect(entry).toEqual({
      pid: 4242,
      sessionId: '6f1c2a9e-0d3b-4c55-9a77-1b2c3d4e5f60',
      cwd: '/home/dev/acme-shop',
      status: 'busy',
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'refactor cart',
    });
  });

  it('reads malformed optional fields as absent', () => {
    const entry = SessionRegistryEntry.parse({ pid: 7, sessionId: 'abc', cwd: 42, name: {} });
    expect(entry).toEqual({ pid: 7, sessionId: 'abc' });
  });

  it('rejects entries without a pid or session id', () => {
    expect(SessionRegistryEntry.safeParse({ sessionId: 'abc' }).success).toBe(false);
    expect(SessionRegistryEntry.safeParse({ pid: -1, sessionId: 'abc' }).success).toBe(false);
    expect(SessionRegistryEntry.safeParse({ pid: 7, sessionId: '' }).success).toBe(false);
  });
});

describe('SessionHistoryEntry', () => {
  it('defaults unknown token usage to null', () => {
    const entry = SessionHistoryEntry.parse({
      id: '6f1c2a9e-0d3b-4c55-9a77-1b2c3d4e5f60',
      projectId: 'p1',
      title: 'Refactor cart',
      firstPrompt: null,
      cwd: '/home/dev/acme-shop',
      gitBranch: 'main',
      createdAt: null,
      updatedAt: 1,
      fileSize: null,
    });
    expect(entry.tokens).toBeNull();
  });
});

describe('RESUMABLE_SESSION_ID', () => {
  it('admits session ids and nothing a shell would interpret', () => {
    expect(RESUMABLE_SESSION_ID.test('6f1c2a9e-0d3b-4c55-9a77-1b2c3d4e5f60')).toBe(true);
    for (const bad of ['', '-rf', 'a b', 'a;b', 'a$(b)', 'a`b`', 'a\nb', 'a|b', '../x']) {
      expect(RESUMABLE_SESSION_ID.test(bad)).toBe(false);
    }
  });
});
