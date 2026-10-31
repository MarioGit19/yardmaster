import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { approval, board, T0 } from './fixtures.test-helpers.js';
import {
  decode,
  decodeEditorToServer,
  decodeServerToEditor,
  decodeServerToUi,
  decodeUiToServer,
  EditorToServer,
  encode,
  encodeServerToUi,
  encodeUiToServer,
  Message,
  makeMessage,
  ServerToEditor,
  ServerToUi,
  UiToServer,
} from './messages.js';

// Synthetic sample data only.
const env = (type: string, payload: unknown, id?: string) => ({
  v: 1,
  type,
  ts: T0,
  payload,
  ...(id ? { id } : {}),
});

const editorToServer: EditorToServer[] = [
  env('editor.hello', {
    windowId: 'win-1',
    appName: 'Cursor',
    appVersion: '3.5.0',
    workspaceFolders: ['/home/dev/acme-shop'],
    extensionVersion: '0.1.0',
    capabilities: { shellExecution: true },
  }),
  env('terminal.upsert', {
    terminalId: 'term-1',
    name: 'zsh',
    shellPid: 4242,
    cwd: '/home/dev/acme-shop',
    state: 'open',
    shellIntegration: true,
    active: true,
    exitCode: null,
  }),
  env('terminal.sync', { terminals: [] }),
  env('terminal.closed', { terminalId: 'term-1', exitCode: 0 }),
  env('exec.start', {
    execId: 'exec-1',
    terminalId: 'term-1',
    commandLine: 'pnpm test',
    confidence: 'high',
    cwd: '/home/dev/acme-shop',
  }),
  env('exec.data', { execId: 'exec-1', seq: 0, chunk: '\u001b[32m✓\u001b[0m 12 passed\r\n' }),
  env('exec.interactive', { execId: 'exec-1' }),
  env('exec.end', { execId: 'exec-1', exitCode: 1 }),
  env('editor.heartbeat', {}),
  env('cmd.result', { id: 'cmd-1', ok: false, error: 'terminal not found' }),
] as EditorToServer[];

const serverToEditor: ServerToEditor[] = [
  env('cmd.sendText', { terminalId: 'term-1', text: 'ls', execute: true }, 'cmd-1'),
  env('cmd.interrupt', { terminalId: 'term-1' }, 'cmd-2'),
  env('cmd.createTerminal', { cwd: '/home/dev/acme-shop', name: 'dev', command: 'pnpm dev' }, 'c3'),
  env('cmd.focusTerminal', { terminalId: 'term-1' }, 'cmd-4'),
  env('cmd.disposeTerminal', { terminalId: 'term-1' }, 'cmd-5'),
  env('cmd.rerun', { execId: 'exec-1' }, 'cmd-6'),
  env('cmd.closeWindow', {}, 'cmd-7'),
] as ServerToEditor[];

const serverToUi: ServerToUi[] = [
  env('snapshot', { state: board }),
  env('patch', {
    ops: [
      { op: 'set', path: ['sessions', 'sess-1', 'status'], value: { kind: 'working' } },
      { op: 'merge', path: ['terminals', 'term-1'], value: { active: false } },
      { op: 'delete', path: ['ports', '127.0.0.1:5173'] },
    ],
  }),
  env('stream.data', { streamId: 'exec:exec-1', seq: 7, chunk: 'ok\n' }),
  env('stream.resync', { streamId: 'term:term-1', fromSeq: 42 }),
  env('action.result', { id: 'act-1', ok: false, error: 'not_implemented' }),
  env('toast', { level: 'warning', title: 'Approval needed', projectId: 'a1b2c3d4e5f6' }),
  env('activity', {
    replace: false,
    events: [
      {
        id: 'evt-1',
        ts: T0,
        kind: 'exec.end',
        projectId: 'a1b2c3d4e5f6',
        sessionId: null,
        terminalId: 'term-1',
        execId: 'exec-1',
        summary: 'pnpm test',
        data: { exitCode: 1 },
      },
    ],
  }),
  env('approval.new', { approval }),
  env('approval.resolved', { approvalId: approval.id, state: 'denied', reason: 'not now' }),
] as ServerToUi[];

const uiToServer: UiToServer[] = [
  env('subscribe', { streamId: 'term:term-1', fromSeq: 10 }),
  env('unsubscribe', { streamId: 'term:term-1' }),
  env('action', { kind: 'terminal.sendText', terminalId: 'term-1', text: 'y', execute: true }),
  env('action', { kind: 'terminal.interrupt', terminalId: 'term-1' }),
  env('action', { kind: 'terminal.rerun', execId: 'exec-1' }),
  env('action', { kind: 'terminal.create', projectId: 'a1b2c3d4e5f6', command: 'pnpm dev' }),
  env('action', { kind: 'terminal.focus', terminalId: 'term-1' }),
  env('action', { kind: 'terminal.close', terminalId: 'term-1' }),
  env('action', {
    kind: 'session.create',
    projectId: 'a1b2c3d4e5f6',
    prompt: 'Fix the cart totals',
    permissionMode: 'acceptEdits',
  }),
  env('action', { kind: 'session.resume', sessionId: 'sess-1', fork: true }),
  env('action', { kind: 'session.resumeInEditor', projectId: 'p1', sessionId: 'sess-1' }),
  env('action', { kind: 'session.interrupt', sessionId: 'sess-1' }),
  env('action', { kind: 'session.close', sessionId: 'sess-1' }),
  env('action', { kind: 'session.rename', sessionId: 'sess-1', title: 'Cart fix' }),
  env('action', { kind: 'session.archive', sessionId: 'sess-1', archived: true }),
  env('action', { kind: 'session.setModel', sessionId: 'sess-1', model: 'claude-sonnet-5-5' }),
  env('action', { kind: 'session.setPermissionMode', sessionId: 'sess-1', permissionMode: 'plan' }),
  env('action', { kind: 'session.replyInTerminal', sessionId: 'sess-1', text: 'yes, go ahead' }),
  env('action', { kind: 'session.parallel', projectId: 'a1b2c3d4e5f6' }),
  env('action', {
    kind: 'git.commit',
    projectId: 'a1b2c3d4e5f6',
    revision: 'a'.repeat(64),
    message: 'fix: settle the tax rate',
  }),
  env('action', {
    kind: 'git.discard',
    projectId: 'a1b2c3d4e5f6',
    worktree: 'f6e5d4c3b2a1',
    revision: 'b'.repeat(64),
    path: 'src/cart.ts',
  }),
  env('action', { kind: 'project.add', path: '/home/dev/acme-shop' }),
  env('action', { kind: 'project.close', projectId: 'a1b2c3d4e5f6' }),
  env('action', { kind: 'project.close', projectId: 'a1b2c3d4e5f6', closeWindow: true }),
  env('action', { kind: 'project.forget', projectId: 'a1b2c3d4e5f6' }),
  env('action', { kind: 'project.openInEditor', projectId: 'a1b2c3d4e5f6' }),
  env('action', { kind: 'folder.trust', path: '/home/dev/cloned-tool', hash: 'd'.repeat(64) }),
  env('action', { kind: 'settings.set', key: 'motion', value: 'reduced' }),
  env('session.send', { sessionId: 'sess-1', text: 'Now add a test' }),
  env('approval.decide', { approvalId: approval.id, decision: 'allow' }),
  env('approval.decide', { approvalId: approval.id, decision: 'allowAlways' }),
  env('approval.decide', { approvalId: approval.id, decision: 'deny', reason: 'use pnpm' }),
  env('terminal.input', { terminalId: 'board-1', data: 'ls\r' }),
  env('terminal.resize', { terminalId: 'board-1', cols: 120, rows: 30 }),
  env('presence', { focused: true, pushId: 'push-1' }),
  env('presence', { focused: false, pushId: null }),
] as UiToServer[];

function unionTypes(schema: z.ZodDiscriminatedUnion): string[] {
  return schema.options.map((option) => {
    const shape = (option as z.ZodObject).shape as { type: z.ZodLiteral<string> };
    return shape.type.value;
  });
}

const channels = [
  { name: 'editor → server', schema: EditorToServer, samples: editorToServer },
  { name: 'server → editor', schema: ServerToEditor, samples: serverToEditor },
  { name: 'server → UI', schema: ServerToUi, samples: serverToUi },
  { name: 'UI → server', schema: UiToServer, samples: uiToServer },
] as const;

describe.each(channels)('$name', ({ schema, samples }) => {
  it('has a sample for every message type', () => {
    const sampled = new Set(samples.map((m) => m.type));
    expect([...sampled].sort()).toEqual(unionTypes(schema).sort());
  });

  it.each(samples.map((m) => [m.type, m] as const))('round-trips %s', (_type, message) => {
    const encoded = encode(schema, message);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decode(schema, encoded.data);
    expect(decoded).toEqual({ ok: true, message });
  });
});

describe('UI actions', () => {
  it('covers every action kind', () => {
    const action = UiToServer.options.find((o) => o.shape.type.value === 'action');
    if (!action) throw new Error('no action message');
    const kinds = (action.shape.payload as z.ZodDiscriminatedUnion).options.map(
      (o) => ((o as z.ZodObject).shape as { kind: z.ZodLiteral<string> }).kind.value,
    );
    const sampled = uiToServer.flatMap((m) => (m.type === 'action' ? [m.payload.kind] : []));
    expect(new Set(sampled)).toEqual(new Set(kinds));
  });
});

describe('board terminal input', () => {
  it('refuses empty input, oversized input and impossible sizes', () => {
    const bad = [
      env('terminal.input', { terminalId: 'board-1', data: '' }),
      env('terminal.input', { terminalId: 'board-1', data: 'x'.repeat(64 * 1024 + 1) }),
      env('terminal.resize', { terminalId: 'board-1', cols: 0, rows: 30 }),
      env('terminal.resize', { terminalId: 'board-1', cols: 80, rows: 1.5 }),
    ];
    for (const message of bad) expect(decode(UiToServer, message).ok).toBe(false);
  });
});

describe('decode', () => {
  const reject = (raw: unknown, schema: z.ZodType = UiToServer) => {
    const result = decode(schema, raw);
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.reason;
  };

  it('rejects invalid JSON without throwing', () => {
    expect(reject('{"v":1,')).toBe('invalid JSON');
    expect(reject('')).toBe('invalid JSON');
  });

  it('rejects non-objects', () => {
    for (const raw of [null, undefined, 42, 'null', '[]', true]) {
      expect(reject(raw)).not.toBe('');
    }
  });

  it('rejects a wrong protocol version', () => {
    expect(reject({ ...uiToServer[1], v: 2 })).toMatch(/^v:/);
  });

  it('rejects unknown message types', () => {
    expect(reject(env('nope', {}))).toMatch(/^type:/);
  });

  it('rejects messages sent on the wrong channel', () => {
    expect(decodeUiToServer(serverToUi[2]).ok).toBe(false);
    expect(decodeEditorToServer(serverToEditor[0]).ok).toBe(false);
    expect(decodeServerToEditor(editorToServer[0]).ok).toBe(false);
    expect(decodeServerToUi(uiToServer[0]).ok).toBe(false);
  });

  it('names the offending field', () => {
    const bad = env('exec.data', { execId: 'exec-1', seq: -1, chunk: 'x' });
    expect(reject(bad, EditorToServer)).toMatch(/^payload\.seq:/);
  });

  it('rejects a missing or bad timestamp', () => {
    const { ts: _ts, ...noTs } = env('editor.heartbeat', {});
    expect(reject(noTs, EditorToServer)).toMatch(/^ts:/);
    expect(reject({ ...env('editor.heartbeat', {}), ts: -5 }, EditorToServer)).toMatch(/^ts:/);
  });

  it('requires an id on server commands', () => {
    const { id: _id, ...noId } = serverToEditor[0] as ServerToEditor;
    expect(reject(noId, ServerToEditor)).toMatch(/^id:/);
  });

  it('rejects unknown action kinds and approval decisions', () => {
    expect(reject(env('action', { kind: 'rm.rf', path: '/' }))).toMatch(/^payload\.kind:/);
    expect(reject(env('approval.decide', { approvalId: 'a', decision: 'maybe' }))).toMatch(
      /^payload\.decision:/,
    );
  });

  it('rejects malformed stream ids and patch ops', () => {
    expect(reject(env('subscribe', { streamId: 'file:/etc/passwd' }))).toMatch(/streamId/);
    const badPatch = env('patch', { ops: [{ op: 'move', path: ['x'] }] });
    expect(reject(badPatch, ServerToUi)).toMatch(/^payload\.ops\.0\.op:/);
    expect(reject(env('patch', { ops: [{ op: 'delete', path: [] }] }), ServerToUi)).toMatch(/path/);
  });

  it('rejects an invalid board state in a snapshot', () => {
    const state = {
      ...board,
      sessions: { wrong: board.sessions[Object.keys(board.sessions)[0] ?? ''] },
    };
    expect(reject(env('snapshot', { state }), ServerToUi)).toMatch(/^payload\.state\.sessions/);
  });

  it('enforces maxLength before parsing', () => {
    const raw = JSON.stringify(uiToServer[1]);
    expect(decode(UiToServer, raw, { maxLength: raw.length }).ok).toBe(true);
    const result = decode(UiToServer, raw, { maxLength: raw.length - 1 });
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/longer than/) });
  });

  it('strips unknown fields', () => {
    const result = decodeUiToServer({ ...uiToServer[1], extra: 1 });
    expect(result.ok && 'extra' in result.message).toBe(false);
  });

  it('accepts every channel through the combined Message schema', () => {
    for (const m of [...editorToServer, ...serverToEditor, ...serverToUi, ...uiToServer]) {
      expect(Message.safeParse(m).success).toBe(true);
    }
  });
});

describe('encode', () => {
  it('refuses to serialize an invalid message', () => {
    const bad = { ...serverToUi[2], payload: { streamId: 'exec:x', seq: 1.5, chunk: '' } };
    const result = encodeServerToUi(bad as ServerToUi);
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^payload\.seq:/) });
  });

  it('produces plain JSON', () => {
    const result = encodeUiToServer(uiToServer[1] as UiToServer);
    expect(result.ok && JSON.parse(result.data)).toEqual(uiToServer[1]);
  });
});

describe('makeMessage', () => {
  it('fills in the envelope', () => {
    const msg = makeMessage<UiToServer>('session.send', { sessionId: 's', text: 'hi' }, { ts: T0 });
    expect(msg).toEqual({
      v: 1,
      type: 'session.send',
      ts: T0,
      payload: { sessionId: 's', text: 'hi' },
    });
    expect(decodeUiToServer(msg).ok).toBe(true);
  });

  it('sets the id when given and defaults ts to now', () => {
    const before = Date.now();
    const msg = makeMessage<ServerToEditor>('cmd.rerun', { execId: 'e' }, { id: 'cmd-9' });
    expect(msg.id).toBe('cmd-9');
    expect(msg.ts).toBeGreaterThanOrEqual(before);
    expect(decodeServerToEditor(msg).ok).toBe(true);
  });
});
