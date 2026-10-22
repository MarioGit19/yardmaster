import { describe, expect, it } from 'vitest';
import { SessionRegistryEntry } from './claude-sessions.js';

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
