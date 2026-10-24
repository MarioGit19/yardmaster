import { type ClaudeSession, type Terminal, toolFamily } from '@yardmaster/protocol';
import { runningBackground } from '../background/model.js';
import type { OrbState } from '../orb/model.js';

/** The crew member's states, DESIGN.md §4.11. */
export const MASCOT_STATES = [
  'sleeping',
  'idle',
  'watching',
  'thinking',
  'typing',
  'reading',
  'running',
  'delegating',
  'waiting',
  'error',
  'done',
] as const;
export type MascotState = (typeof MASCOT_STATES)[number];

/** No activity for this long puts the crew member to sleep. */
export const SLEEP_AFTER_MS = 5 * 60_000;

/** The states that act out work; leaving one for idle plays "done". */
const WORKING = new Set<MascotState>(['thinking', 'typing', 'reading', 'running', 'delegating']);

export const isWorking = (state: MascotState) => WORKING.has(state);

/**
 * What the mapping needs from a terminal. `streaming` and `lastOutputAt` come from the store's
 * activity levels; without them a terminal only counts from when it opened or closed.
 */
export type CrewTerminal = Pick<Terminal, 'state' | 'createdAt' | 'closedAt'> & {
  streaming?: boolean;
  lastOutputAt?: number | null;
};

export interface MascotStateOptions {
  now?: number;
  /** The state shown before, so finishing a turn can play "done" once. */
  previous?: MascotState | null;
}

function toolState(tool: string): MascotState {
  switch (toolFamily(tool)) {
    case 'edit':
    case 'todo':
      return 'typing';
    case 'read':
    case 'search':
    case 'web':
      return 'reading';
    case 'bash':
      return 'running';
    case 'task':
      return 'delegating';
    default:
      return 'thinking';
  }
}

function lastTerminalActivity(terminal: CrewTerminal): number {
  return Math.max(terminal.lastOutputAt ?? 0, terminal.closedAt ?? 0, terminal.createdAt);
}

/** At rest: watching a streaming terminal, idle after recent activity, asleep after 5 min. */
function restingState(lastActivity: number, terminals: readonly CrewTerminal[], now: number) {
  if (terminals.some((t) => t.state === 'open' && t.streaming)) return 'watching';
  const latest = terminals.reduce((max, t) => Math.max(max, lastTerminalActivity(t)), lastActivity);
  return now - latest >= SLEEP_AFTER_MS ? 'sleeping' : 'idle';
}

/**
 * The crew member's state for a session (or a project without one) and its terminals,
 * DESIGN.md §4.11.
 */
export function mascotStateFor(
  session: ClaudeSession | null,
  terminals: readonly CrewTerminal[],
  { now = Date.now(), previous = null }: MascotStateOptions = {},
): MascotState {
  if (!session) return restingState(Number.NEGATIVE_INFINITY, terminals, now);
  const { status } = session;
  switch (status.kind) {
    case 'error':
      return 'error';
    case 'waiting_permission':
    case 'waiting_input':
      return 'waiting';
    case 'tool':
      return toolState(status.tool);
    case 'working':
      return session.currentTool?.status === 'error' ? 'error' : 'thinking';
    case 'compacting':
      return 'thinking';
    case 'ended':
    case 'interrupted':
      return restingState(Number.NEGATIVE_INFINITY, terminals, now);
    case 'unknown':
      if (!status.alive) return restingState(Number.NEGATIVE_INFINITY, terminals, now);
      return awake(session, restingState(session.updatedAt, terminals, now));
    case 'idle':
      if (previous && isWorking(previous)) return 'done';
      return awake(session, restingState(session.updatedAt, terminals, now));
  }
}

/** Nobody sleeps while their watcher or subagent still runs. */
function awake(session: ClaudeSession, state: MascotState): MascotState {
  return state === 'sleeping' && runningBackground(session) > 0 ? 'idle' : state;
}

/** The antenna orb follows the crew member's state. */
export function mascotOrbState(state: MascotState): OrbState {
  switch (state) {
    case 'thinking':
      return 'working';
    case 'typing':
    case 'reading':
    case 'running':
    case 'delegating':
      return 'tool';
    case 'waiting':
      return 'waiting';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

/** The tool a state stands for when the caller doesn't name one, for the orb's particle color. */
export const STATE_TOOL: Partial<Record<MascotState, string>> = {
  typing: 'Edit',
  reading: 'Read',
  running: 'Bash',
  delegating: 'Task',
};

/** 24 px: eyes, antenna orb and posture only. 56 px: full acting. 120 px: props in detail. */
export type MascotDetail = 'posture' | 'acting' | 'detailed';

export function mascotDetail(size: number): MascotDetail {
  if (size < 40) return 'posture';
  if (size < 96) return 'acting';
  return 'detailed';
}

/** Mini crew members drawn beside the parent; more turns into clutter at 56 px. */
export const MAX_MINI_CREW = 3;

export function miniCrewCount(state: MascotState, subagents: number): number {
  const running = Math.max(0, Math.floor(subagents));
  return Math.min(MAX_MINI_CREW, state === 'delegating' ? Math.max(1, running) : running);
}

/** Milliseconds a one-shot state plays before settling. */
export const DONE_MS = 1400;
export const ERROR_X_EYES_MS = 600;

/** Uniform in [min, max), for per-instance idle variety. */
export const between = (min: number, max: number, random = Math.random) =>
  min + (max - min) * random();

export const BLINK_EVERY_MS = [2000, 6000] as const;
export const LOOK_AROUND_EVERY_MS = [8000, 15000] as const;

const STATE_LABEL: Record<MascotState, string> = {
  sleeping: 'Asleep',
  idle: 'Idle',
  watching: 'Watching a terminal',
  thinking: 'Thinking',
  typing: 'Typing',
  reading: 'Reading',
  running: 'Running a command',
  delegating: 'Delegating to a subagent',
  waiting: 'Waiting for you',
  error: 'Hit an error',
  done: 'Done',
};

/** Background tasks drawn as helpers beside the crew member; more show as "+N". */
export const MAX_HELPERS = 3;

export function mascotLabel(
  state: MascotState,
  tool: string | null,
  minis: number,
  helpers = 0,
): string {
  let label =
    tool && (state === 'typing' || state === 'reading' || state === 'running')
      ? `${STATE_LABEL[state]} (${tool})`
      : STATE_LABEL[state];
  if (minis > 0) label += `, ${minis} subagent${minis === 1 ? '' : 's'}`;
  if (helpers > 0) label += `, ${helpers} in background`;
  return label;
}
