import { describe, expect, it } from 'vitest';
import { ActivityEvent } from './domain.js';
import {
  HOOK_EVENT_NAMES,
  KnownHookEvent,
  normalizeHookEvent,
  stopFailureReason,
  summarizeToolInput,
} from './hooks.js';

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { eager: true; import: 'default' }): Record<string, T>;
  }
}

const fixtures = import.meta.glob<Record<string, unknown>>('../fixtures/hooks/*.json', {
  eager: true,
  import: 'default',
});
const entries = Object.entries(fixtures).map(
  ([path, raw]) => [path.split('/').pop() ?? path, raw] as const,
);
const byName = (name: string) => {
  const raw = fixtures[`../fixtures/hooks/${name}.json`];
  if (!raw) throw new Error(`missing fixture ${name}`);
  return raw;
};

const T = 1_760_000_000_000;

describe('hook fixtures', () => {
  it('covers every subscribed event', () => {
    const names = new Set(entries.map(([, raw]) => raw.hook_event_name));
    for (const event of HOOK_EVENT_NAMES) expect(names).toContain(event);
  });

  it.each(entries)('%s parses and normalizes', (file, raw) => {
    const known = KnownHookEvent.safeParse(raw);
    expect(known.success).toBe(!file.startsWith('unknown'));
    const event = normalizeHookEvent(raw, 5151, { now: T, id: 'evt-1' });
    expect(ActivityEvent.safeParse(event).success).toBe(true);
    expect(event.sessionId).toBe(byName('pre-tool-use-bash').session_id);
    expect(event.data.claudePid).toBe(5151);
    expect(event.data.cwd).toBe('/home/dev/acme-shop');
  });
});

describe('normalizeHookEvent', () => {
  const kinds: Record<string, string> = {
    'session-start': 'session.start',
    'session-end': 'session.end',
    'user-prompt-submit': 'prompt',
    'pre-tool-use-bash': 'tool.start',
    'post-tool-use': 'tool.end',
    'post-tool-use-failure': 'tool.error',
    'notification-permission': 'notification',
    stop: 'stop',
    'stop-failure': 'stop.failure',
    'subagent-start': 'subagent.start',
    'subagent-stop': 'subagent.stop',
    'pre-compact': 'compact.start',
    'post-compact': 'compact.end',
    'permission-request': 'permission.request',
    'permission-denied': 'permission.denied',
    'task-created': 'task.created',
    'task-completed': 'task.completed',
    'cwd-changed': 'cwd.changed',
    'notification-agent-needs-input': 'notification',
    'notification-agent-completed': 'notification',
    'notification-quota-fired': 'notification',
    'notification-quota-stale': 'notification',
    'notification-quota-disabled': 'notification',
    'stop-failure-auth': 'stop.failure',
    'stop-failure-billing': 'stop.failure',
    'unknown-event': 'unknown',
  };

  it.each(Object.entries(kinds))('%s → %s', (name, kind) => {
    expect(normalizeHookEvent(byName(name)).kind).toBe(kind);
  });

  it('names the reason a turn failed, when it has one', () => {
    expect(normalizeHookEvent(byName('stop-failure')).data.reason).toBe('rate_limit');
    expect(normalizeHookEvent(byName('stop-failure-auth')).data.reason).toBe('auth');
    expect(stopFailureReason('server_error')).toBeNull();
    expect(stopFailureReason(undefined)).toBeNull();
    expect(stopFailureReason('constructor')).toBeNull();
  });

  it('keeps the details of the newer events', () => {
    expect(normalizeHookEvent(byName('cwd-changed')).data).toMatchObject({
      oldCwd: '/home/dev/acme-shop',
      newCwd: '/home/dev/acme-shop/packages/cart',
    });
    expect(normalizeHookEvent(byName('task-created')).summary).toBe('Wire the cart totals');
    expect(normalizeHookEvent(byName('permission-denied')).data).toMatchObject({
      tool: 'Bash',
      reason: 'Blocked by the auto mode classifier',
    });
  });

  it('uses the given clock and id', () => {
    const event = normalizeHookEvent(byName('stop'), undefined, { now: T, id: 'evt-9' });
    expect(event.ts).toBe(T);
    expect(event.id).toBe('evt-9');
    expect(event.data.claudePid).toBeNull();
  });

  it('generates distinct ids by default', () => {
    const a = normalizeHookEvent(byName('stop'));
    const b = normalizeHookEvent(byName('stop'));
    expect(a.id).not.toBe(b.id);
  });

  it('extracts tool details', () => {
    const event = normalizeHookEvent(byName('pre-tool-use-bash'));
    expect(event.summary).toBe('Bash: pnpm test');
    expect(event.data).toMatchObject({
      hookEvent: 'PreToolUse',
      tool: 'Bash',
      toolUseId: 'toolu_01AbCdEfGhIjKlMnOpQrStUv',
      permissionMode: 'default',
    });
    expect(normalizeHookEvent(byName('pre-tool-use-edit')).summary).toBe(
      'Edit: /home/dev/acme-shop/src/cart.ts',
    );
  });

  it('keeps the notification type for the status machine', () => {
    expect(normalizeHookEvent(byName('notification-idle')).data.notificationType).toBe(
      'idle_prompt',
    );
    expect(normalizeHookEvent(byName('notification-permission')).data.notificationType).toBe(
      'permission_prompt',
    );
  });

  it('reports failure errors', () => {
    expect(normalizeHookEvent(byName('post-tool-use-failure')).data.error).toBe(
      'Command failed with exit code 1',
    );
    expect(normalizeHookEvent(byName('stop-failure')).summary).toBe('rate_limit');
  });

  it('keeps the event name and session for unknown events', () => {
    const event = normalizeHookEvent(byName('unknown-event'));
    expect(event.kind).toBe('unknown');
    expect(event.summary).toBe('FutureEvent');
    expect(event.data.hookEvent).toBe('FutureEvent');
  });

  it('treats a known event with a malformed field as unknown', () => {
    const raw = { ...byName('pre-tool-use-bash'), tool_name: 42 };
    const event = normalizeHookEvent(raw);
    expect(event.kind).toBe('unknown');
    expect(event.sessionId).toBe(byName('pre-tool-use-bash').session_id);
  });

  it.each([
    null,
    undefined,
    'SessionStart',
    42,
    [],
    {},
    { hook_event_name: 'Stop' },
    { session_id: '', hook_event_name: 'Stop' },
  ])('never throws on garbage input %#', (raw) => {
    const event = normalizeHookEvent(raw, -1, { now: Number.NaN });
    expect(event.kind).toBe('unknown');
    expect(event.sessionId).toBeNull();
    expect(event.data.claudePid).toBeNull();
    expect(ActivityEvent.safeParse(event).success).toBe(true);
  });

  it('passes unknown fields through', () => {
    const raw = { ...byName('stop'), future_field: 'x' };
    const parsed = KnownHookEvent.parse(raw);
    expect((parsed as Record<string, unknown>).future_field).toBe('x');
  });
});

describe('summarizeToolInput', () => {
  it('falls back to the tool name', () => {
    expect(summarizeToolInput('TodoWrite', { todos: [] })).toBe('TodoWrite');
    expect(summarizeToolInput('Grep', { pattern: 'TODO' })).toBe('Grep: TODO');
  });

  it('collapses whitespace and clips long input', () => {
    const summary = summarizeToolInput('Bash', { command: `echo\n${'x'.repeat(500)}` });
    expect(summary.startsWith('Bash: echo x')).toBe(true);
    expect(summary.length).toBe(200);
    expect(summary.endsWith('…')).toBe(true);
  });
});
