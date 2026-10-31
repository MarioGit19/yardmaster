import type { Approval, ClaudeSession } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import type { BoardStoreState } from '../data/store.js';
import { makeProject, makeSession, sampleBoard } from '../test/board.js';
import {
  approvalHeadline,
  attentionKey,
  canAlwaysAllow,
  EXPIRE_FINISH_MS,
  inboxInterrupt,
  inboxItems,
  inboxModeSwitch,
  landsOnAttention,
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

  it('opens the session on Enter', () => {
    expect(key('Enter')).toEqual({ kind: 'open' });
  });

  it('leaves chords and other keys alone', () => {
    expect(key('a', { meta: true })).toBeNull();
    expect(key('a', { ctrl: true })).toBeNull();
    expect(key('d', { alt: true })).toBeNull();
    expect(key('D', { shift: true })).toBeNull();
    expect(key('x')).toBeNull();
    expect(key('Enter', { meta: true })).toBeNull();
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

describe('inboxItems', () => {
  it('merges approvals and waiting sessions, oldest first', () => {
    const items = inboxItems(
      [
        { ...approval('a-new', 's-1', 'pending'), createdAt: 300 },
        { ...approval('a-old', 's-2', 'pending'), createdAt: 100 },
      ],
      [{ ...makeSession('s-3', 'p-1', { kind: 'waiting_input' }), updatedAt: 200 }],
    );
    expect(items.map((item) => item.key)).toEqual(['a-old', 's:s-3', 'a-new']);
  });
});

describe('inboxInterrupt', () => {
  const waiting = { kind: 'waiting_permission', approvalId: 'a' } as const;
  const on = (
    origin: 'board' | 'terminal',
    terminalId: string | null,
    status: ClaudeSession['status'] = waiting,
  ) => ({ ...makeSession('s-1', 'p-1', status), origin, terminalId });

  it('answers a request the hook holds with a stop', () => {
    const session = on('terminal', 't-1');
    expect(inboxInterrupt(session, { source: 'hook' })).toEqual({ kind: 'stopRequest' });
  });

  it('stops a board session through the SDK', () => {
    const session = on('board', null);
    expect(inboxInterrupt(session, { source: 'sdk' })).toEqual({
      kind: 'action',
      action: { kind: 'session.interrupt', sessionId: 's-1' },
    });
  });

  it('presses Esc at a terminal prompt with no request behind it', () => {
    const session = on('terminal', 't-1');
    expect(inboxInterrupt(session, null)).toMatchObject({
      action: { kind: 'terminal.sendText', terminalId: 't-1', execute: false },
    });
  });

  it('has nothing to stop in a session waiting for a reply', () => {
    const session = on('board', null, { kind: 'waiting_input' });
    expect(inboxInterrupt(session, null)).toBeNull();
  });

  it('has no way into a terminal session without a terminal', () => {
    const session = on('terminal', null);
    expect(inboxInterrupt(session, null)).toBeNull();
  });
});

describe('inboxModeSwitch', () => {
  it('switches a board session directly', () => {
    expect(inboxModeSwitch({ origin: 'board', permissionMode: null }, { source: 'sdk' })).toEqual({
      kind: 'session',
    });
  });

  it('offers a terminal session only the hook modes it is not in', () => {
    expect(
      inboxModeSwitch({ origin: 'terminal', permissionMode: 'acceptEdits' }, { source: 'hook' }),
    ).toEqual({ kind: 'allowWith', modes: ['default', 'plan'] });
  });

  it('never offers a terminal prompt with no hook behind it', () => {
    expect(inboxModeSwitch({ origin: 'terminal', permissionMode: null }, null)).toBeNull();
  });
});

describe('landsOnAttention', () => {
  const env = { standalone: true, location: '/', waiting: 1 };

  it('sends the installed app to the Attention tab when anything is pending', () => {
    expect(landsOnAttention(env)).toBe(true);
  });

  it('stays put in a browser tab, on a deep link, or with nothing pending', () => {
    expect(landsOnAttention({ ...env, standalone: false })).toBe(false);
    expect(landsOnAttention({ ...env, location: '/p/acme' })).toBe(false);
    expect(landsOnAttention({ ...env, waiting: 0 })).toBe(false);
  });
});
