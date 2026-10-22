import type { Approval } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import type { BoardStoreState } from '../data/store.js';
import { makeProject, makeSession, sampleBoard } from '../test/board.js';
import {
  approvalHeadline,
  attentionKey,
  canAlwaysAllow,
  EXPIRE_FINISH_MS,
  lingerFor,
  relativeToProject,
  selectWaitingWithoutApproval,
} from './attention.js';

const key = (key: string, mods: Partial<Record<'shift' | 'meta' | 'ctrl' | 'alt', boolean>> = {}) =>
  attentionKey({
    key,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
  });

function approval(id: string, sessionId: string, state: Approval['state']): Approval {
  return {
    id,
    sessionId,
    source: 'sdk',
    tool: 'Bash',
    input: { command: 'pnpm test' },
    toolUseId: null,
    createdAt: 1,
    expiresAt: null,
    state,
    decidedAt: null,
    reason: null,
  };
}

describe('attentionKey', () => {
  it('maps A, ⇧A and D to decisions', () => {
    expect(key('a')).toEqual({ kind: 'decide', decision: 'allow' });
    expect(key('A', { shift: true })).toEqual({ kind: 'decide', decision: 'allowAlways' });
    expect(key('d')).toEqual({ kind: 'decide', decision: 'deny' });
  });

  it('moves with the arrows and J/K', () => {
    expect(key('ArrowDown')).toEqual({ kind: 'move', by: 1 });
    expect(key('j')).toEqual({ kind: 'move', by: 1 });
    expect(key('ArrowUp')).toEqual({ kind: 'move', by: -1 });
    expect(key('k')).toEqual({ kind: 'move', by: -1 });
  });

  it('leaves chords and other keys alone', () => {
    expect(key('a', { meta: true })).toBeNull();
    expect(key('a', { ctrl: true })).toBeNull();
    expect(key('d', { alt: true })).toBeNull();
    expect(key('D', { shift: true })).toBeNull();
    expect(key('x')).toBeNull();
    expect(key('Enter')).toBeNull();
  });
});

describe('selectWaitingWithoutApproval', () => {
  it('keeps sessions the board cannot answer with a card', () => {
    const board = sampleBoard();
    board.sessions['s-3'] = makeSession('s-3', 'p-orbit', {
      kind: 'waiting_permission',
      approvalId: 'ap-1',
    });
    board.sessions['s-4'] = makeSession('s-4', 'p-zen', { kind: 'waiting_input' });
    board.sessions['s-5'] = makeSession('s-5', 'p-zen', {
      kind: 'waiting_permission',
      approvalId: 'ap-2',
    });
    board.approvals['ap-1'] = approval('ap-1', 's-3', 'pending');
    board.approvals['ap-2'] = approval('ap-2', 's-5', 'allowed');
    const ids = selectWaitingWithoutApproval({ board } as BoardStoreState).map((s) => s.id);
    // s-1 has no approval id, s-4 waits for a reply, s-5's approval is no longer pending.
    expect(ids.sort()).toEqual(['s-1', 's-4', 's-5']);
  });
});

describe('helpers', () => {
  it('only offers Always allow with suggestions', () => {
    expect(canAlwaysAllow({})).toBe(false);
    expect(canAlwaysAllow({ suggestions: [] })).toBe(false);
    expect(
      canAlwaysAllow({
        suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      }),
    ).toBe(true);
  });

  it('names the project in the headline', () => {
    const project = makeProject('p-acme', 'acme-shop');
    expect(approvalHeadline({ tool: 'Bash' }, project)).toBe('acme-shop wants to run Bash');
    expect(approvalHeadline({ tool: 'Edit' }, undefined)).toBe('Claude wants to run Edit');
  });

  it('shows project paths relative to the project', () => {
    expect(relativeToProject('/home/dev/acme-shop/src/a.ts', '/home/dev/acme-shop')).toBe(
      'src/a.ts',
    );
    expect(relativeToProject('/home/dev/acme-shopper/a.ts', '/home/dev/acme-shop')).toBe(
      '/home/dev/acme-shopper/a.ts',
    );
    expect(relativeToProject('/etc/hosts', undefined)).toBe('/etc/hosts');
  });
});

describe('lingerFor', () => {
  it('holds an allowed card long enough to draw its check and collapse', () => {
    expect(lingerFor('allowed', 'full')).toBeGreaterThan(lingerFor('allowed', 'reduced'));
    expect(lingerFor('denied', 'full')).toBeLessThan(lingerFor('allowed', 'full'));
  });

  it('lets an expired ring finish first', () => {
    expect(lingerFor('expired', 'full')).toBeGreaterThan(EXPIRE_FINISH_MS);
  });

  it('removes decided cards at once with motion off', () => {
    for (const state of ['allowed', 'denied', 'expired'] as const) {
      expect(lingerFor(state, 'off')).toBe(0);
    }
  });
});
