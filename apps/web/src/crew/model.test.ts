import type { ClaudeSession, SessionStatus } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import {
  type CrewTerminal,
  MASCOT_STATES,
  type MascotState,
  mascotDetail,
  mascotLabel,
  mascotOrbState,
  mascotStateFor,
  miniCrewCount,
  SLEEP_AFTER_MS,
} from './model.js';

// Synthetic data only.
const NOW = 1_760_000_600_000;

function session(status: SessionStatus, extra: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    id: '0c9d8e7f-1a2b-4c3d-8e9f-a0b1c2d3e4f5',
    origin: 'terminal',
    projectId: 'p1',
    cwd: '/home/dev/acme-shop',
    status,
    title: null,
    model: null,
    permissionMode: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: null,
    currentTool: null,
    todos: [],
    subagents: [],
    terminalId: null,
    claudePid: null,
    transcriptPath: null,
    lastAssistantText: null,
    startedAt: NOW - 60_000,
    updatedAt: NOW - 1000,
    endedAt: null,
    ...extra,
  };
}

const tool = (name: string): SessionStatus => ({ kind: 'tool', tool: name, toolUseId: null });

const quiet: CrewTerminal = { state: 'open', createdAt: NOW - 30_000, closedAt: null };
const streaming: CrewTerminal = { ...quiet, streaming: true, lastOutputAt: NOW - 100 };
const stale: CrewTerminal = { state: 'open', createdAt: NOW - SLEEP_AFTER_MS - 1, closedAt: null };

describe('mascotStateFor', () => {
  it.each([
    ['Edit', 'typing'],
    ['MultiEdit', 'typing'],
    ['Write', 'typing'],
    ['NotebookEdit', 'typing'],
    ['Read', 'reading'],
    ['Grep', 'reading'],
    ['Glob', 'reading'],
    ['WebFetch', 'reading'],
    ['WebSearch', 'reading'],
    ['Bash', 'running'],
    ['Task', 'delegating'],
    ['mcp__docs__search', 'thinking'],
  ] as const)('acts out %s as %s', (name, expected) => {
    expect(mascotStateFor(session(tool(name)), [], { now: NOW })).toBe(expected);
  });

  it('thinks while working without a tool, and while compacting', () => {
    expect(mascotStateFor(session({ kind: 'working' }), [], { now: NOW })).toBe('thinking');
    expect(
      mascotStateFor(session({ kind: 'compacting', previous: { kind: 'working' } }), [], {
        now: NOW,
      }),
    ).toBe('thinking');
  });

  it('waits for permission and for input', () => {
    const permission = session({ kind: 'waiting_permission', approvalId: null });
    expect(mascotStateFor(permission, [streaming], { now: NOW })).toBe('waiting');
    expect(mascotStateFor(session({ kind: 'waiting_input' }), [], { now: NOW })).toBe('waiting');
  });

  it('shows an error for a failed turn and for a failed tool', () => {
    expect(mascotStateFor(session({ kind: 'error', message: null }), [], { now: NOW })).toBe(
      'error',
    );
    const failed = session(
      { kind: 'working' },
      {
        currentTool: {
          id: 't1',
          sessionId: 's1',
          tool: 'Bash',
          family: 'bash',
          summary: 'pnpm test',
          startedAt: NOW - 2000,
          endedAt: NOW - 1000,
          status: 'error',
        },
      },
    );
    expect(mascotStateFor(failed, [], { now: NOW })).toBe('error');
  });

  it('plays done once when a turn ends, then rests', () => {
    const idle = session({ kind: 'idle' });
    for (const previous of ['thinking', 'typing', 'reading', 'running', 'delegating'] as const) {
      expect(mascotStateFor(idle, [], { now: NOW, previous })).toBe('done');
    }
    expect(mascotStateFor(idle, [], { now: NOW, previous: 'done' })).toBe('idle');
    expect(mascotStateFor(idle, [], { now: NOW, previous: 'waiting' })).toBe('idle');
  });

  it('watches while Claude is idle and a terminal streams', () => {
    expect(mascotStateFor(session({ kind: 'idle' }), [streaming], { now: NOW })).toBe('watching');
    const closed: CrewTerminal = { ...streaming, state: 'closed', closedAt: NOW - 10 };
    expect(mascotStateFor(session({ kind: 'idle' }), [closed], { now: NOW })).toBe('idle');
  });

  it('falls asleep after five minutes without any activity', () => {
    const old = session({ kind: 'idle' }, { updatedAt: NOW - SLEEP_AFTER_MS });
    expect(mascotStateFor(old, [], { now: NOW })).toBe('sleeping');
    expect(mascotStateFor(old, [stale], { now: NOW })).toBe('sleeping');
    // Recent terminal output keeps it awake.
    const recent: CrewTerminal = { ...stale, lastOutputAt: NOW - 60_000 };
    expect(mascotStateFor(old, [recent], { now: NOW })).toBe('idle');
    const fresh = session({ kind: 'idle' }, { updatedAt: NOW - SLEEP_AFTER_MS + 1 });
    expect(mascotStateFor(fresh, [], { now: NOW })).toBe('idle');
  });

  it('treats a live unknown session as idle and an ended one as resting', () => {
    expect(mascotStateFor(session({ kind: 'unknown', alive: true }), [], { now: NOW })).toBe(
      'idle',
    );
    expect(mascotStateFor(session({ kind: 'unknown', alive: false }), [], { now: NOW })).toBe(
      'sleeping',
    );
    expect(mascotStateFor(session({ kind: 'ended' }), [], { now: NOW })).toBe('sleeping');
    expect(mascotStateFor(session({ kind: 'ended' }), [streaming], { now: NOW })).toBe('watching');
  });

  it('follows the terminals when the project has no session', () => {
    expect(mascotStateFor(null, [streaming], { now: NOW })).toBe('watching');
    expect(mascotStateFor(null, [quiet], { now: NOW })).toBe('idle');
    expect(mascotStateFor(null, [stale], { now: NOW })).toBe('sleeping');
    expect(mascotStateFor(null, [], { now: NOW })).toBe('sleeping');
  });
});

describe('mascotOrbState', () => {
  it('maps every state to an orb state', () => {
    const map = Object.fromEntries(MASCOT_STATES.map((s) => [s, mascotOrbState(s)]));
    expect(map).toEqual({
      sleeping: 'idle',
      idle: 'idle',
      watching: 'idle',
      thinking: 'working',
      typing: 'tool',
      reading: 'tool',
      running: 'tool',
      delegating: 'tool',
      waiting: 'waiting',
      error: 'error',
      done: 'idle',
    } satisfies Record<MascotState, string>);
  });
});

describe('mascotDetail', () => {
  it('drops props below 40 px and adds detail from 96 px', () => {
    expect(mascotDetail(24)).toBe('posture');
    expect(mascotDetail(56)).toBe('acting');
    expect(mascotDetail(120)).toBe('detailed');
  });
});

describe('miniCrewCount', () => {
  it('shows one mini crew member while delegating and caps the crowd', () => {
    expect(miniCrewCount('delegating', 0)).toBe(1);
    expect(miniCrewCount('thinking', 2)).toBe(2);
    expect(miniCrewCount('idle', 9)).toBe(3);
    expect(miniCrewCount('idle', -1)).toBe(0);
  });
});

describe('mascotLabel', () => {
  it('names the tool and the subagents', () => {
    expect(mascotLabel('typing', 'Edit', 0)).toBe('Typing (Edit)');
    expect(mascotLabel('delegating', 'Task', 2)).toBe('Delegating to a subagent, 2 subagents');
    expect(mascotLabel('sleeping', null, 0)).toBe('Asleep');
  });
});
