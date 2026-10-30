import { describe, expect, it } from 'vitest';
import {
  isAutomaticSessionName,
  isAutomaticTerminalName,
  nextSessionOrdinal,
  sessionDisplayName,
  sessionSubtitle,
  terminalDisplayName,
  worktreeName,
} from './display-names.js';
import type { ClaudeSession } from './domain.js';

describe('worktreeName', () => {
  it('reads the worktree folder out of a path', () => {
    expect(worktreeName('/home/dev/acme-shop/.claude/worktrees/tax-fix')).toBe('tax-fix');
    expect(worktreeName('/home/dev/acme-shop/.claude/worktrees/tax-fix/src')).toBe('tax-fix');
    expect(worktreeName('/home/dev/acme-shop/.worktrees/tax-fix')).toBe('tax-fix');
  });

  it('finds none in an ordinary folder', () => {
    expect(worktreeName('/home/dev/acme-shop')).toBeNull();
    expect(worktreeName('/home/dev/worktrees/acme-shop')).toBeNull();
    expect(worktreeName(null)).toBeNull();
  });
});

describe('isAutomaticTerminalName', () => {
  it.each(['zsh', 'bash', 'fish', 'sh', 'pwsh', 'node', 'python', 'python3.12', 'claude'])(
    '%s is automatic',
    (name) => expect(isAutomaticTerminalName(name)).toBe(true),
  );

  it.each([
    'claude.exe',
    'node.exe',
    '/bin/zsh',
    '-zsh',
    'zsh (2)',
    '',
    '  ',
    '✳ Fix the cart',
    'Claude Code',
  ])('%j is automatic', (name) => expect(isAutomaticTerminalName(name)).toBe(true));

  it.each(['backend', 'storefront', 'admin', 'dev server', 'zsh logs', 'Claude helper'])(
    '%s is a user name',
    (name) => expect(isAutomaticTerminalName(name)).toBe(false),
  );
});

describe('terminalDisplayName', () => {
  const zsh = { name: 'zsh', cwd: '/home/dev/storefront' };

  it('keeps a name the user gave', () => {
    expect(terminalDisplayName({ name: ' backend ', cwd: null }, { running: 'pnpm dev' })).toEqual({
      name: 'backend',
      raw: null,
    });
  });

  it('replaces an automatic name with the running command, then the last one', () => {
    expect(terminalDisplayName(zsh, { running: 'pnpm dev', last: 'ls' })).toEqual({
      name: 'pnpm dev',
      raw: 'zsh',
    });
    expect(terminalDisplayName(zsh, { running: null, last: 'git status' }).name).toBe('git status');
  });

  it('truncates a long command to its first line', () => {
    const { name } = terminalDisplayName(zsh, {
      running: `pnpm --filter @acme/storefront run build:production --verbose\necho done`,
    });
    expect(name).toHaveLength(32);
    expect(name.endsWith('…')).toBe(true);
  });

  it('falls back to the folder plus shell', () => {
    expect(terminalDisplayName(zsh)).toEqual({ name: 'storefront · zsh', raw: 'zsh' });
    expect(terminalDisplayName({ name: 'bash', cwd: null })).toEqual({ name: 'bash', raw: null });
    expect(terminalDisplayName({ name: '', cwd: null }).name).toBe('Terminal');
    expect(terminalDisplayName({ name: '', cwd: '/home/dev/admin' }).name).toBe('admin');
  });

  it('names a Claude terminal after its session unless the user renamed it', () => {
    const session = { title: 'acme-shop-c3', ordinal: 2 };
    expect(terminalDisplayName({ name: 'claude.exe', cwd: null }, { session })).toEqual({
      name: 'Claude 2',
      raw: 'claude.exe',
    });
    expect(
      terminalDisplayName({ name: 'node', cwd: null }, { session: { title: null } }).name,
    ).toBe('Claude');
    expect(terminalDisplayName({ name: 'agent', cwd: null }, { session }).name).toBe('agent');
  });
});

describe('session names', () => {
  it('detects Claude Code automatic names', () => {
    expect(isAutomaticSessionName('acme-shop-c3', '/home/dev/acme-shop')).toBe(true);
    expect(isAutomaticSessionName('Acme Shop-x9', '/home/dev/Acme Shop/')).toBe(true);
    expect(isAutomaticSessionName('acme-shop-checkout-refactor', '/home/dev/acme-shop')).toBe(
      false,
    );
    expect(isAutomaticSessionName('fix-auth', '/home/dev/acme-shop')).toBe(false);
    expect(isAutomaticSessionName('acme-shop-c3', null)).toBe(false);
  });

  it('shows a custom title, else Claude with its number', () => {
    expect(sessionDisplayName({ title: 'acme-shop-c3', customTitle: 'Checkout' })).toBe('Checkout');
    expect(sessionDisplayName({ title: 'acme-shop-c3' })).toBe('Claude');
    expect(sessionDisplayName({ title: null, ordinal: 1 })).toBe('Claude');
    expect(sessionDisplayName({ title: null, ordinal: 3 })).toBe('Claude 3');
    expect(sessionDisplayName({ title: null, customTitle: '  ', ordinal: 2 })).toBe('Claude 2');
  });

  it('keeps the automatic name for the subtitle', () => {
    expect(sessionSubtitle({ title: 'acme-shop-c3' })).toBe('acme-shop-c3');
    expect(sessionSubtitle({ title: ' ' })).toBeNull();
    expect(sessionSubtitle({ title: 'Checkout', customTitle: 'Checkout' })).toBeNull();
  });
});

describe('nextSessionOrdinal', () => {
  type Row = Pick<ClaudeSession, 'id' | 'projectId' | 'status' | 'customTitle' | 'ordinal'>;
  const live = { kind: 'idle' } as const;
  const ended = { kind: 'ended' } as const;
  const row = (id: string, ordinal: number | null, extra: Partial<Row> = {}): Row => ({
    id,
    projectId: 'p',
    status: live,
    customTitle: null,
    ordinal,
    ...extra,
  });

  it('numbers by start and never renumbers when one ends', () => {
    const rows: Row[] = [];
    const start = (id: string) => {
      const ordinal = nextSessionOrdinal(rows, { id, projectId: 'p' });
      rows.push(row(id, ordinal));
      return ordinal;
    };
    expect([start('a'), start('b'), start('c')]).toEqual([1, 2, 3]);
    // "a" ends: b and c keep 2 and 3, and the next session takes the free 1.
    rows[0] = { ...(rows[0] as Row), status: ended };
    expect(rows.map((r) => r.ordinal)).toEqual([1, 2, 3]);
    expect(start('d')).toBe(1);
    expect(start('e')).toBe(4);
  });

  it('ignores named sessions, other projects and the session itself', () => {
    const rows = [
      row('named', 1, { customTitle: 'Checkout' }),
      row('other', 1, { projectId: 'q' }),
      row('self', 1),
    ];
    expect(nextSessionOrdinal(rows, { id: 'self', projectId: 'p' })).toBe(1);
  });
});
