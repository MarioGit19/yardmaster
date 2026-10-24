import {
  type BoardState,
  type EditorWindow,
  type Execution,
  emptyBoardState,
  type Project,
  type Terminal,
} from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { createEditorActions } from './editor-actions.js';
import { EditorRouter, ROUTE_ERRORS } from './editor-router.js';

const T0 = 1_760_000_000_000;

function project(id: string, path: string): Project {
  return {
    id,
    path,
    name: path.split('/').pop() ?? id,
    accent: 0,
    source: 'editor',
    git: null,
    createdAt: T0,
    lastActivityAt: null,
  };
}

function window(id: string, projectIds: string[], lastSeenAt = T0): EditorWindow {
  return {
    id,
    appName: 'Cursor',
    appVersion: '1.93.0',
    extensionVersion: '0.1.0',
    workspaceFolders: [],
    projectIds,
    capabilities: { shellExecution: true },
    connectedAt: T0,
    lastSeenAt,
  };
}

function terminal(id: string, windowId: string, overrides: Partial<Terminal> = {}): Terminal {
  return {
    id,
    windowId,
    projectId: 'shop',
    name: 'zsh',
    shellPid: null,
    cwd: null,
    state: 'open',
    shellIntegration: true,
    active: false,
    exitCode: null,
    executionIds: [],
    stats: null,
    createdAt: T0,
    closedAt: null,
    ...overrides,
  };
}

function execution(id: string, terminalId: string, commandLine = 'pnpm test'): Execution {
  return {
    id,
    terminalId,
    commandLine,
    confidence: 'high',
    cwd: null,
    startedAt: T0,
    endedAt: T0 + 10,
    exitCode: 0,
    outputBytes: 0,
    truncated: false,
    interactive: false,
  };
}

function board(): BoardState {
  const state = emptyBoardState();
  state.projects = {
    shop: project('shop', '/home/dev/acme-shop'),
    web: project('web', '/home/dev/acme-shop/apps/web'),
    api: project('api', '/home/dev/acme-api'),
    shopper: project('shopper', '/home/dev/acme-shopper'),
    lone: project('lone', '/home/dev/lone-tool'),
  };
  state.windows = {
    'win-shop': window('win-shop', ['shop'], T0 + 5),
    'win-web': window('win-web', ['web'], T0 + 1),
    'win-api': window('win-api', ['api', 'shop'], T0 + 9),
    'win-gone': window('win-gone', ['lone']),
  };
  state.terminals = {
    't-open': terminal('t-open', 'win-shop'),
    't-closed': terminal('t-closed', 'win-shop', { state: 'closed', closedAt: T0 + 1 }),
    't-gone': terminal('t-gone', 'win-gone'),
  };
  state.executions = {
    'e-1': execution('e-1', 't-open'),
    'e-closed': execution('e-closed', 't-closed'),
    'e-blank': execution('e-blank', 't-open', '  '),
  };
  return state;
}

function router(state = board(), offline: string[] = ['win-gone']) {
  return new EditorRouter({
    state: () => state,
    isConnected: (windowId) => !offline.includes(windowId),
  });
}

describe('EditorRouter', () => {
  it('routes a terminal to the window that owns it', () => {
    expect(router().forTerminal('t-open')).toMatchObject({ ok: true, windowId: 'win-shop' });
  });

  it('refuses unknown, closed and offline terminals', () => {
    const r = router();
    expect(r.forTerminal('nope')).toEqual({ ok: false, error: ROUTE_ERRORS.unknownTerminal });
    expect(r.forTerminal('t-closed')).toEqual({ ok: false, error: ROUTE_ERRORS.terminalClosed });
    expect(r.forTerminal('t-gone')).toEqual({ ok: false, error: ROUTE_ERRORS.editorOffline });
  });

  it('routes an execution through its terminal', () => {
    const r = router();
    expect(r.forExecution('e-1')).toMatchObject({ ok: true, windowId: 'win-shop' });
    expect(r.forExecution('e-closed')).toEqual({
      ok: false,
      error: ROUTE_ERRORS.terminalClosed,
    });
    expect(r.forExecution('nope')).toEqual({ ok: false, error: ROUTE_ERRORS.unknownExecution });
  });

  it('prefers a window with the project as a folder, most recently seen first', () => {
    expect(router().forProject('shop')).toMatchObject({ ok: true, windowId: 'win-api' });
    expect(router(board(), ['win-api', 'win-gone']).forProject('shop')).toMatchObject({
      ok: true,
      windowId: 'win-shop',
    });
    expect(router().forProject('web')).toMatchObject({ ok: true, windowId: 'win-web' });
  });

  it('falls back to the window whose folder contains the project most closely', () => {
    const state = board();
    state.projects.deep = project('deep', '/home/dev/acme-shop/apps/web/src');
    expect(router(state).forProject('deep')).toMatchObject({ ok: true, windowId: 'win-web' });
    // A sibling with a shared name prefix is not inside the folder.
    expect(router(state).forProject('shopper')).toEqual({
      ok: false,
      error: ROUTE_ERRORS.noEditor,
    });
  });

  it('reports offline when only a disconnected window has the project', () => {
    const r = router();
    expect(r.forProject('lone')).toEqual({ ok: false, error: ROUTE_ERRORS.editorOffline });
    expect(r.forProject('nope')).toEqual({ ok: false, error: ROUTE_ERRORS.unknownProject });
  });
});

describe('createEditorActions', () => {
  function setup() {
    const sent: { windowId: string; type: string; payload: unknown }[] = [];
    const actions = createEditorActions({
      router: router(),
      send: async (windowId, type, payload) => {
        sent.push({ windowId, type, payload });
        return { ok: true };
      },
    });
    return { actions, sent };
  }

  it('turns terminal actions into commands for the owning window', async () => {
    const { actions, sent } = setup();
    const terminalId = 't-open';
    await actions['terminal.sendText']({
      kind: 'terminal.sendText',
      terminalId,
      text: 'ls',
      execute: true,
    });
    await actions['terminal.interrupt']({ kind: 'terminal.interrupt', terminalId });
    await actions['terminal.focus']({ kind: 'terminal.focus', terminalId });
    await actions['terminal.close']({ kind: 'terminal.close', terminalId });
    await actions['terminal.rerun']({ kind: 'terminal.rerun', execId: 'e-1' });
    await actions['terminal.create']({ kind: 'terminal.create', projectId: 'web' });
    await actions['terminal.create']({
      kind: 'terminal.create',
      projectId: 'api',
      name: 'server',
      command: 'pnpm dev',
    });
    expect(sent).toEqual([
      {
        windowId: 'win-shop',
        type: 'cmd.sendText',
        payload: { terminalId, text: 'ls', execute: true },
      },
      { windowId: 'win-shop', type: 'cmd.interrupt', payload: { terminalId } },
      { windowId: 'win-shop', type: 'cmd.focusTerminal', payload: { terminalId } },
      { windowId: 'win-shop', type: 'cmd.disposeTerminal', payload: { terminalId } },
      { windowId: 'win-shop', type: 'cmd.rerun', payload: { execId: 'e-1' } },
      {
        windowId: 'win-web',
        type: 'cmd.createTerminal',
        payload: { cwd: '/home/dev/acme-shop/apps/web', name: 'web' },
      },
      {
        windowId: 'win-api',
        type: 'cmd.createTerminal',
        payload: { cwd: '/home/dev/acme-api', name: 'server', command: 'pnpm dev' },
      },
    ]);
  });

  it('returns routing errors without sending anything', async () => {
    const { actions, sent } = setup();
    expect(
      await actions['terminal.interrupt']({ kind: 'terminal.interrupt', terminalId: 't-gone' }),
    ).toEqual({ ok: false, error: ROUTE_ERRORS.editorOffline });
    expect(await actions['terminal.rerun']({ kind: 'terminal.rerun', execId: 'e-blank' })).toEqual({
      ok: false,
      error: 'nothing_to_rerun',
    });
    expect(
      await actions['terminal.create']({ kind: 'terminal.create', projectId: 'shopper' }),
    ).toEqual({ ok: false, error: ROUTE_ERRORS.noEditor });
    expect(sent).toEqual([]);
  });
});
