import type { EditorTerminal, Terminal } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { linkTerminalProject, type TerminalContext, terminalReducer } from './terminal-reducer.js';

const T0 = 1_700_000_000_000;
const windowId = 'win-1';
const projects = {
  shop: { id: 'shop', path: '/home/dev/acme-shop' },
  web: { id: 'web', path: '/home/dev/acme-shop/apps/web' },
  api: { id: 'api', path: '/home/dev/acme-api' },
};

function ctx(overrides: Partial<TerminalContext> = {}): TerminalContext {
  return {
    windowId,
    projects,
    windowProjectIds: ['api', 'shop'],
    resolvedCwd: null,
    now: T0,
    ...overrides,
  };
}

function editorTerminal(overrides: Partial<EditorTerminal> = {}): EditorTerminal {
  return {
    terminalId: 'term-1',
    name: 'zsh',
    shellPid: 4242,
    cwd: '/home/dev/acme-shop',
    state: 'open',
    shellIntegration: true,
    active: true,
    exitCode: null,
    ...overrides,
  };
}

function terminal(overrides: Partial<Terminal> = {}): Terminal {
  return {
    id: 'term-1',
    windowId,
    projectId: 'shop',
    name: 'zsh',
    shellPid: 4242,
    cwd: '/home/dev/acme-shop',
    state: 'open',
    shellIntegration: true,
    active: true,
    exitCode: null,
    executionIds: ['exec-1'],
    stats: { pid: 4242, cpu: 1.5, rssBytes: 1024, processCount: 2, sampledAt: T0 },
    createdAt: T0 - 5_000,
    closedAt: null,
    ...overrides,
  };
}

describe('linkTerminalProject', () => {
  it('picks the deepest project containing the cwd', () => {
    expect(linkTerminalProject(ctx({ resolvedCwd: '/home/dev/acme-shop/apps/web/src' }))).toBe(
      'web',
    );
    expect(linkTerminalProject(ctx({ resolvedCwd: '/home/dev/acme-shop' }))).toBe('shop');
  });

  it('does not match a sibling folder that only shares a name prefix', () => {
    expect(linkTerminalProject(ctx({ resolvedCwd: '/home/dev/acme-shopping' }))).toBe('api');
  });

  it("falls back to the window's first known folder", () => {
    expect(linkTerminalProject(ctx({ resolvedCwd: '/tmp' }))).toBe('api');
    expect(linkTerminalProject(ctx({ windowProjectIds: ['gone', 'shop'] }))).toBe('shop');
  });

  it('is null without a matching cwd or window folder', () => {
    expect(linkTerminalProject(ctx({ resolvedCwd: '/tmp', windowProjectIds: [] }))).toBeNull();
  });
});

describe('terminalReducer', () => {
  it('creates a terminal from its first upsert', () => {
    const next = terminalReducer(
      undefined,
      { type: 'upsert', terminal: editorTerminal() },
      ctx({ resolvedCwd: '/home/dev/acme-shop' }),
    );
    expect(next).toEqual({
      id: 'term-1',
      windowId,
      projectId: 'shop',
      name: 'zsh',
      shellPid: 4242,
      cwd: '/home/dev/acme-shop',
      state: 'open',
      shellIntegration: true,
      active: true,
      exitCode: null,
      executionIds: [],
      stats: null,
      createdAt: T0,
      closedAt: null,
    });
  });

  it("links a terminal without a cwd to the window's folder", () => {
    const next = terminalReducer(
      undefined,
      { type: 'upsert', terminal: editorTerminal({ cwd: null, shellIntegration: false }) },
      ctx(),
    );
    expect(next).toMatchObject({ projectId: 'api', cwd: null, shellIntegration: false });
  });

  it('updates fields and keeps executions, stats and createdAt', () => {
    const next = terminalReducer(
      terminal(),
      {
        type: 'upsert',
        terminal: editorTerminal({
          name: 'node',
          cwd: '/home/dev/acme-shop/apps/web',
          active: false,
        }),
      },
      ctx({ resolvedCwd: '/home/dev/acme-shop/apps/web' }),
    );
    expect(next).toMatchObject({
      name: 'node',
      cwd: '/home/dev/acme-shop/apps/web',
      projectId: 'web',
      active: false,
      executionIds: ['exec-1'],
      stats: { cpu: 1.5 },
      createdAt: T0 - 5_000,
    });
  });

  it('keeps the known pid and cwd when an upsert lacks them', () => {
    const next = terminalReducer(
      terminal(),
      { type: 'upsert', terminal: editorTerminal({ shellPid: null, cwd: null }) },
      ctx({ resolvedCwd: '/home/dev/acme-shop' }),
    );
    expect(next).toMatchObject({ shellPid: 4242, cwd: '/home/dev/acme-shop', projectId: 'shop' });
  });

  it('keeps the previous project when nothing links anymore', () => {
    const next = terminalReducer(
      terminal(),
      { type: 'upsert', terminal: editorTerminal({ cwd: '/tmp' }) },
      ctx({ resolvedCwd: '/tmp', windowProjectIds: [] }),
    );
    expect(next?.projectId).toBe('shop');
  });

  it('records a closed state from an upsert, inactive and with a close time', () => {
    const next = terminalReducer(
      terminal(),
      { type: 'upsert', terminal: editorTerminal({ state: 'closed', exitCode: 130 }) },
      ctx(),
    );
    expect(next).toMatchObject({ state: 'closed', active: false, exitCode: 130, closedAt: T0 });
  });

  it('closes a known terminal', () => {
    const next = terminalReducer(terminal(), { type: 'closed', exitCode: 1 }, ctx());
    expect(next).toMatchObject({ state: 'closed', active: false, exitCode: 1, closedAt: T0 });
    expect(next?.executionIds).toEqual(['exec-1']);
  });

  it('keeps the first close time and a known exit code on a repeated close', () => {
    const once = terminalReducer(terminal(), { type: 'closed', exitCode: 2 }, ctx());
    const twice = terminalReducer(
      once ?? undefined,
      { type: 'closed', exitCode: null },
      ctx({ now: T0 + 1_000 }),
    );
    expect(twice).toMatchObject({ exitCode: 2, closedAt: T0 });
  });

  it('ignores a close for an unknown terminal', () => {
    expect(terminalReducer(undefined, { type: 'closed', exitCode: 0 }, ctx())).toBeNull();
  });

  it('ignores events for a terminal owned by another window', () => {
    const other = terminal({ windowId: 'win-2' });
    expect(
      terminalReducer(other, { type: 'upsert', terminal: editorTerminal() }, ctx()),
    ).toBeNull();
    expect(terminalReducer(other, { type: 'closed', exitCode: 0 }, ctx())).toBeNull();
  });
});
