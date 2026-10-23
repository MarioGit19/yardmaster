import type { ClaudeSession } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { claudeColumnSession } from './claudeColumn.js';

const session = (id: string, projectId = 'p-acme') => ({ id, projectId }) as ClaudeSession;

describe('claudeColumnSession', () => {
  const live = [session('s-1'), session('s-2')];

  it("shows the route's session", () => {
    const selected = session('s-2');
    expect(
      claudeColumnSession({
        projectId: 'p-acme',
        sessionId: 's-2',
        selected,
        live,
        released: 's-2',
      }),
    ).toBe(selected);
  });

  it("shows nothing for a missing or another project's session", () => {
    const base = { projectId: 'p-acme', sessionId: 's-9', live, released: null };
    expect(claudeColumnSession({ ...base, selected: undefined })).toBeUndefined();
    expect(claudeColumnSession({ ...base, selected: session('s-9', 'p-orbit') })).toBeUndefined();
  });

  it('falls back to the most relevant live session', () => {
    const base = { projectId: 'p-acme', sessionId: undefined, selected: undefined, live };
    expect(claudeColumnSession({ ...base, released: null })?.id).toBe('s-1');
  });

  it('skips the session the stack took over', () => {
    const base = { projectId: 'p-acme', sessionId: undefined, selected: undefined };
    expect(claudeColumnSession({ ...base, live, released: 's-1' })?.id).toBe('s-2');
    expect(
      claudeColumnSession({ ...base, live: [session('s-1')], released: 's-1' }),
    ).toBeUndefined();
  });
});
