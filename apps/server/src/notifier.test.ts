import {
  type Approval,
  MASK,
  type NotifyEvent,
  type PushPayload,
  type ServerToUi,
} from '@yardmaster/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_GRACE_MS, formatDuration, Notifier, type NotifierSettings } from './notifier.js';
import { type PushSender, PushSubscriptions, type SendResult } from './push.js';
import { BoardStore } from './store.js';

const PROJECT = 'proj-acme';
const OTHER = 'proj-other';
const SESSION = 'sess-1';
const TERMINAL = 'term-1';
const silent = { warn: () => {}, debug: () => {}, info: () => {} };

interface Sent {
  subscriptionId: string;
  payload: PushPayload;
  urgency: string;
}

function setup(
  overrides: Partial<NotifierSettings> & {
    subscriptions?: number;
    focused?: string[];
    result?: (id: string) => SendResult;
    before?: (store: BoardStore) => void;
  } = {},
) {
  const store = new BoardStore({ autoFlush: false });
  for (const [id, name] of [
    [PROJECT, 'acme-shop'],
    [OTHER, 'other-app'],
  ] as const) {
    store.upsertProject({
      id,
      path: `/home/dev/${name}`,
      name,
      accent: 0,
      source: 'manual',
      git: null,
      createdAt: 0,
      lastActivityAt: null,
    });
  }
  store.upsertSession({ id: SESSION, projectId: PROJECT, status: { kind: 'idle' } });
  store.upsertTerminal({ id: TERMINAL, windowId: 'board', name: 'zsh', projectId: PROJECT });
  overrides.before?.(store);
  store.flush();

  const saved: unknown[] = [];
  const subscriptions = new PushSubscriptions({ load: () => [], save: (s) => saved.push(s) });
  for (let i = 0; i < (overrides.subscriptions ?? 1); i++) {
    subscriptions.add(
      {
        endpoint: `https://fcm.googleapis.com/fcm/send/device-${i}`,
        keys: { p256dh: `key${i}`, auth: `auth${i}` },
      },
      { deviceId: `session-${i}`, userAgent: undefined },
    );
  }
  const ids = subscriptions.list().map((s) => s.id);
  const sent: Sent[] = [];
  const send: PushSender = async (subscription, payload, { urgency }) => {
    sent.push({ subscriptionId: subscription.id, payload, urgency });
    return overrides.result?.(subscription.id) ?? { ok: true };
  };
  const toasts: ServerToUi[] = [];
  const settings: NotifierSettings = {
    events: new Set<NotifyEvent>(['needs_you', 'claude_finished', 'command_finished', 'crashed']),
    hideDetails: false,
    muted: new Set(),
    away: false,
    ...overrides,
  };
  const notifier = new Notifier({
    store,
    subscriptions,
    send,
    settings: () => settings,
    focused: () => new Set((overrides.focused ?? []).map((i) => ids[Number(i)] ?? i)),
    onMessage: (message) => toasts.push(message),
    logger: silent,
  });
  const shows = () =>
    sent.flatMap((s) =>
      s.payload.type === 'show' ? [{ ...s.payload, to: s.subscriptionId }] : [],
    );
  return { store, notifier, subscriptions, ids, sent, shows, toasts, settings };
}

function approval(id: string, fields: Partial<Approval> = {}): Approval {
  return {
    id,
    sessionId: SESSION,
    source: 'hook',
    tool: 'Bash',
    input: { command: 'rm -rf dist' },
    toolUseId: null,
    createdAt: Date.now(),
    expiresAt: null,
    state: 'pending',
    decidedAt: null,
    reason: null,
    ...fields,
  };
}

function runCommand(
  store: BoardStore,
  execId: string,
  {
    ranMs,
    exitCode,
    line = 'pnpm test',
  }: { ranMs: number; exitCode: number | null; line?: string },
) {
  store.startExec({
    execId,
    terminalId: TERMINAL,
    commandLine: line,
    confidence: 'high',
    cwd: null,
    startedAt: Date.now() - ranMs,
    header: false,
  });
  store.flush();
  store.endExec(execId, exitCode);
  store.flush();
}

/** A Claude turn that started `ranMs` ago and ends now. */
function runTurn(store: BoardStore, ranMs: number, sessionId = SESSION) {
  store.setSessionStatus(sessionId, { kind: 'working' }, Date.now() - ranMs);
  store.flush();
  store.updateSession(sessionId, { lastAssistantText: 'Done.\nAll green.' });
  store.setSessionStatus(sessionId, { kind: 'idle' });
  store.flush();
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Notifier events', () => {
  it('pushes an approval as Claude needing you, with the project, tool, caption and link', async () => {
    const { store, shows, sent } = setup();
    store.upsertApproval(approval('ap-1'));
    store.setSessionStatus(SESSION, { kind: 'waiting_permission', approvalId: 'ap-1' });
    store.flush();
    await vi.runAllTimersAsync();
    expect(shows()).toEqual([
      expect.objectContaining({
        kind: 'needs_you',
        title: 'acme-shop · Claude wants to run Bash',
        body: 'rm -rf dist',
        tag: `project:${PROJECT}`,
        url: `/#/p/${PROJECT}/s/${SESSION}`,
        request: 'ap-1',
        approvalId: null,
      }),
    ]);
    expect(sent[0]?.urgency).toBe('high');
  });

  it('offers Allow / Deny on approvals only in away mode', () => {
    const { store, shows } = setup({ away: true });
    store.upsertApproval(approval('ap-1'));
    store.flush();
    expect(shows()[0]?.approvalId).toBe('ap-1');
  });

  it('pushes a session waiting for input, and a terminal prompt after the approval grace', async () => {
    const { store, shows } = setup();
    store.setSessionStatus(SESSION, { kind: 'waiting_input' });
    store.flush();
    expect(shows().map((s) => s.title)).toEqual(['acme-shop · Claude is waiting for you']);

    const second = setup();
    second.store.setSessionStatus(SESSION, { kind: 'waiting_permission', approvalId: null });
    second.store.flush();
    expect(second.shows()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(APPROVAL_GRACE_MS);
    expect(second.shows().map((s) => s.title)).toEqual(['acme-shop · Claude needs your approval']);
  });

  it('waits for an away-mode approval card instead of pushing the bare prompt', async () => {
    const { store, shows } = setup();
    store.setSessionStatus(SESSION, { kind: 'waiting_permission', approvalId: null });
    store.flush();
    await vi.advanceTimersByTimeAsync(APPROVAL_GRACE_MS / 2);
    store.upsertApproval(approval('ap-2'));
    store.setSessionStatus(SESSION, { kind: 'waiting_permission', approvalId: 'ap-2' });
    store.flush();
    await vi.advanceTimersByTimeAsync(APPROVAL_GRACE_MS * 2);
    expect(shows().map((s) => s.request)).toEqual(['ap-2']);
  });

  it('pushes a finished Claude turn only past 30 s', () => {
    const { store, shows } = setup();
    runTurn(store, 29_000);
    expect(shows()).toHaveLength(0);
    runTurn(store, 31_000);
    expect(shows()).toEqual([
      expect.objectContaining({
        kind: 'claude_finished',
        title: 'acme-shop · Claude finished',
        body: 'Done.',
      }),
    ]);
  });

  it('pushes a finished command only past 30 s, with ✓ or the exit code', async () => {
    const { store, shows } = setup();
    runCommand(store, 'e-short', { ranMs: 29_000, exitCode: 0 });
    expect(shows()).toHaveLength(0);
    runCommand(store, 'e-ok', { ranMs: 31_000, exitCode: 0 });
    await vi.advanceTimersByTimeAsync(20_000);
    runCommand(store, 'e-fail', { ranMs: 125_000, exitCode: 2, line: 'pnpm build' });
    expect(shows()).toEqual([
      expect.objectContaining({
        kind: 'command_finished',
        title: 'acme-shop · ✓ pnpm test',
        body: 'Ran for 31s',
        url: `/#/p/${PROJECT}/t/${TERMINAL}`,
      }),
      expect.objectContaining({
        kind: 'command_finished',
        title: 'acme-shop · pnpm build exited 2',
        body: 'Ran for 2m 5s',
      }),
    ]);
  });

  it('skips commands the user stopped, TUIs, and history from before it started', async () => {
    const { store, shows } = setup();
    runCommand(store, 'e-int', { ranMs: 60_000, exitCode: 130 });
    store.startExec({
      execId: 'e-tui',
      terminalId: TERMINAL,
      commandLine: 'htop',
      confidence: 'high',
      cwd: null,
      startedAt: Date.now() - 60_000,
      header: false,
    });
    store.markExecInteractive('e-tui');
    store.flush();
    store.endExec('e-tui', 0);
    store.flush();
    expect(shows()).toHaveLength(0);
  });

  it('pushes a crash: a dev server that served a port, or a process killed by a signal', async () => {
    const { store, shows } = setup();
    store.startExec({
      execId: 'e-dev',
      terminalId: TERMINAL,
      commandLine: 'pnpm dev',
      confidence: 'high',
      cwd: null,
      startedAt: Date.now() - 5_000,
      header: false,
    });
    store.flush();
    store.setPorts([
      {
        id: '127.0.0.1:5173',
        port: 5173,
        address: '127.0.0.1',
        pid: 4242,
        command: 'node',
        terminalId: TERMINAL,
        projectId: PROJECT,
        firstSeenAt: Date.now(),
      },
    ]);
    store.flush();
    store.endExec('e-dev', 1);
    store.flush();
    await vi.advanceTimersByTimeAsync(20_000);
    runCommand(store, 'e-seg', { ranMs: 2_000, exitCode: 139, line: './render' });
    // A quick failure of an ordinary command is not a crash.
    await vi.advanceTimersByTimeAsync(20_000);
    runCommand(store, 'e-typo', { ranMs: 1_000, exitCode: 127, line: 'pnmp test' });
    expect(shows()).toEqual([
      expect.objectContaining({
        kind: 'crashed',
        title: 'acme-shop · pnpm dev crashed',
        body: 'Exit code 1 after 5s',
      }),
      expect.objectContaining({ kind: 'crashed', title: 'acme-shop · ./render crashed' }),
    ]);
  });

  it('pushes finished background work only when that event is on', () => {
    const agent = {
      id: 'agent-1',
      type: 'Explore',
      description: 'Map the API',
      status: 'running' as const,
      startedAt: 0,
      endedAt: null,
    };
    for (const on of [false, true]) {
      const { store, shows, settings } = setup();
      if (on) settings.events = new Set([...settings.events, 'background']);
      store.updateSession(SESSION, { subagents: [agent] });
      store.flush();
      store.updateSession(SESSION, { subagents: [{ ...agent, status: 'done', endedAt: 1 }] });
      store.flush();
      expect(shows().map((s) => [s.title, s.body])).toEqual(
        on ? [['acme-shop · A subagent finished', 'Map the API']] : [],
      );
    }
  });

  it('pushes nothing for the board as it was when it started, or without subscriptions', () => {
    const { store, shows } = setup({
      before: (board) => board.upsertApproval(approval('ap-old')),
    });
    store.upsertApproval({ ...approval('ap-old'), expiresAt: Date.now() + 60_000 });
    store.flush();
    expect(shows()).toHaveLength(0);

    const empty = setup({ subscriptions: 0 });
    runTurn(empty.store, 60_000);
    expect(empty.shows()).toHaveLength(0);
  });

  it('masks secrets in every push, since pushes show on the lock screen', async () => {
    // Assembled at runtime so no secret-shaped literal sits in the repo.
    const token = `${'gh'}p_${'aB3dE6gH9j'.repeat(4)}`;
    const { store, shows, toasts, settings } = setup();
    settings.events = new Set<NotifyEvent>([...settings.events, 'background']);
    store.upsertApproval(
      approval('ap-1', { input: { command: `curl -H "Authorization: ${token}" api.test` } }),
    );
    store.flush();
    await vi.advanceTimersByTimeAsync(20_000);
    runCommand(store, 'e-1', {
      ranMs: 40_000,
      exitCode: 0,
      line: `API_TOKEN=s3cr3tvalue ${'x'.repeat(70)}`,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    store.setSessionStatus(SESSION, { kind: 'working' }, Date.now() - 40_000);
    store.flush();
    store.updateSession(SESSION, { lastAssistantText: `Set it to ${token} and retry.` });
    store.setSessionStatus(SESSION, { kind: 'idle' });
    store.flush();
    const all = JSON.stringify([shows(), toasts]);
    expect(shows()).toHaveLength(3);
    expect(all).not.toContain(token);
    expect(all).not.toContain('s3cr3tvalue');
    expect(shows().map((s) => [s.title, s.body])).toEqual([
      ['acme-shop · Claude wants to run Bash', `curl -H "Authorization: ghp_${MASK}" api.test`],
      [expect.stringContaining(`✓ API_TOKEN=${MASK} xxx`), 'Ran for 40s'],
      ['acme-shop · Claude finished', `Set it to ghp_${MASK} and retry.`],
    ]);
  });

  it('toasts the board for everything but approvals, which toast on their own', () => {
    const { store, toasts } = setup();
    store.upsertApproval(approval('ap-1'));
    store.flush();
    expect(toasts).toHaveLength(0);
    runCommand(store, 'e-1', { ranMs: 40_000, exitCode: 0 });
    expect(toasts).toEqual([
      expect.objectContaining({
        type: 'toast',
        payload: expect.objectContaining({ level: 'success', title: 'acme-shop · ✓ pnpm test' }),
      }),
    ]);
  });
});

describe('Notifier rules', () => {
  it('skips devices with the board visible and focused', () => {
    const { store, shows, ids } = setup({ subscriptions: 2, focused: ['0'] });
    store.upsertApproval(approval('ap-1'));
    store.flush();
    expect(shows().map((s) => s.to)).toEqual([ids[1]]);
  });

  it('sends at most one push per project per 20 s; later events replace it by tag', async () => {
    const { store, shows } = setup();
    runCommand(store, 'e-1', { ranMs: 40_000, exitCode: 0, line: 'first' });
    runCommand(store, 'e-2', { ranMs: 40_000, exitCode: 0, line: 'second' });
    runCommand(store, 'e-3', { ranMs: 40_000, exitCode: 0, line: 'third' });
    expect(shows().map((s) => s.title)).toEqual(['acme-shop · ✓ first']);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(shows()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(shows().map((s) => [s.title, s.tag])).toEqual([
      ['acme-shop · ✓ first', `project:${PROJECT}`],
      ['acme-shop · ✓ third', `project:${PROJECT}`],
    ]);
  });

  it('keeps a waiting request over a lower-priority event in the coalescing window', async () => {
    const { store, shows } = setup();
    runCommand(store, 'e-1', { ranMs: 40_000, exitCode: 0 });
    store.setSessionStatus(SESSION, { kind: 'waiting_input' });
    store.flush();
    runCommand(store, 'e-2', { ranMs: 40_000, exitCode: 0, line: 'later' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(shows().map((s) => s.kind)).toEqual(['command_finished', 'needs_you']);
  });

  it('coalesces per project: another project pushes at once', () => {
    const { store, shows } = setup();
    store.upsertSession({ id: 'sess-2', projectId: OTHER, status: { kind: 'idle' } });
    store.flush();
    runCommand(store, 'e-1', { ranMs: 40_000, exitCode: 0 });
    store.setSessionStatus('sess-2', { kind: 'waiting_input' });
    store.flush();
    expect(shows().map((s) => s.title)).toEqual([
      'acme-shop · ✓ pnpm test',
      'other-app · Claude is waiting for you',
    ]);
  });

  it('never pushes for a muted project', () => {
    const { store, shows } = setup({ muted: new Set([PROJECT]) });
    store.upsertApproval(approval('ap-1'));
    store.flush();
    runTurn(store, 60_000);
    expect(shows()).toHaveLength(0);
  });

  it('says only which project needs you with Hide details, and offers no blind Allow', () => {
    const { store, shows } = setup({ hideDetails: true, away: true });
    store.upsertApproval(approval('ap-1'));
    store.flush();
    expect(shows()[0]).toMatchObject({
      title: 'acme-shop needs you',
      body: '',
      approvalId: null,
    });

    const finished = setup({ hideDetails: true });
    runCommand(finished.store, 'e-1', { ranMs: 40_000, exitCode: 0 });
    expect(finished.shows()[0]).toMatchObject({
      title: 'acme-shop · a command finished',
      body: '',
    });
  });

  it('closes a request’s notification once it is answered elsewhere', async () => {
    const { store, sent, ids } = setup({ subscriptions: 2, focused: ['1'] });
    store.upsertApproval(approval('ap-1'));
    store.flush();
    store.resolveApproval('ap-1', 'allowed');
    store.flush();
    await vi.runAllTimersAsync();
    expect(sent.map((s) => [s.payload.type, s.subscriptionId])).toEqual([
      ['show', ids[0]],
      ['close', ids[0]],
    ]);
    expect(sent[1]?.payload).toEqual({
      type: 'close',
      tag: `project:${PROJECT}`,
      request: 'ap-1',
    });
  });

  it('drops a coalesced request that was answered before it went out', async () => {
    const { store, shows } = setup();
    runCommand(store, 'e-1', { ranMs: 40_000, exitCode: 0 });
    store.setSessionStatus(SESSION, { kind: 'waiting_input' });
    store.flush();
    store.setSessionStatus(SESSION, { kind: 'working' });
    store.flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(shows().map((s) => s.kind)).toEqual(['command_finished']);
  });

  it('drops a subscription its push service says is gone (410), and keeps the others', async () => {
    let gone = '';
    const { store, subscriptions, ids } = setup({
      subscriptions: 2,
      result: (id) => (id === gone ? { ok: false, gone: true, status: 410 } : { ok: true }),
    });
    gone = ids[0] ?? '';
    store.upsertApproval(approval('ap-1'));
    store.flush();
    await vi.runAllTimersAsync();
    expect(subscriptions.list().map((s) => s.id)).toEqual([ids[1]]);
    expect(subscriptions.get(ids[1] ?? '')?.lastSentAt).toBe(Date.now());
  });

  it('keeps a subscription after other failures', async () => {
    const { store, subscriptions } = setup({
      result: () => ({ ok: false, gone: false, status: 500 }),
    });
    store.upsertApproval(approval('ap-1'));
    store.flush();
    await vi.runAllTimersAsync();
    expect(subscriptions.list()).toHaveLength(1);
  });

  it('sends the test push to one subscription, past every rule', async () => {
    const { notifier, sent, ids } = setup({ subscriptions: 2, focused: ['0'] });
    await expect(notifier.test(ids[0] ?? '')).resolves.toEqual({ ok: true });
    expect(sent).toEqual([
      expect.objectContaining({
        subscriptionId: ids[0],
        payload: expect.objectContaining({ kind: 'test', title: 'Yardmaster · Test notification' }),
      }),
    ]);
  });
});

describe('formatDuration', () => {
  it('reads like a person would say it', () => {
    expect(formatDuration(31_000)).toBe('31s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_600_000 + 15 * 60_000)).toBe('1h 15m');
  });
});
