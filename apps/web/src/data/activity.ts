import type { ActivityEvent, BoardState, PatchOp } from '@c-board/protocol';

// Activity levels, DESIGN.md §4.10: one exponentially decaying event rate per project, session
// and terminal. Animations read the level (0..1) instead of reacting to single events, so they
// speed up and calm down smoothly. Values decay lazily: nothing ticks while the board is quiet.

/** How fast energy fades: after this long without events it is down to 1/e. */
export const ACTIVITY_TAU_MS = 2_500;
/** Below this level an entity counts as quiet (no motion, no frame callbacks). */
export const QUIET_LEVEL = 0.08;
/** One terminal output byte's worth of energy; ~1 KB/s settles around level 0.6. */
const BYTE_ENERGY = 1 / 3_000;
/** A single output patch never adds more than a burst of events would. */
const MAX_OUTPUT_ENERGY = 1.5;

export interface Pulse {
  /** Energy at `at`; the level is `1 - e^-energy`. */
  energy: number;
  at: number;
  /** The newest event or output seen. */
  lastAt: number;
  /** Discrete events seen (hook and exec events, not output), for the per-event sparks. */
  events: number;
  /** When a turn last finished (a `stop` event). */
  doneAt: number | null;
}

export type Pulses = Readonly<Record<string, Pulse>>;

export const activityKey = {
  project: (id: string) => `p:${id}`,
  session: (id: string) => `s:${id}`,
  terminal: (id: string) => `t:${id}`,
};

export function energyAt(pulse: Pulse, now: number): number {
  if (now <= pulse.at) return pulse.energy;
  return pulse.energy * Math.exp(-(now - pulse.at) / ACTIVITY_TAU_MS);
}

/** 0..1: how busy the entity is right now. */
export function levelAt(pulse: Pulse | undefined, now: number): number {
  return pulse ? 1 - Math.exp(-energyAt(pulse, now)) : 0;
}

/** 0 = quiet, 1–3 = how busy, for CSS that switches on a few discrete speeds. */
export function levelStep(level: number): 0 | 1 | 2 | 3 {
  if (level < QUIET_LEVEL) return 0;
  if (level < 0.5) return 1;
  if (level < 0.85) return 2;
  return 3;
}

interface Bump {
  energy: number;
  ts: number;
  event?: boolean;
  done?: boolean;
}

function bump(pulse: Pulse | undefined, { energy, ts, event = false, done = false }: Bump): Pulse {
  const base: Pulse = pulse ?? { energy: 0, at: ts, lastAt: ts, events: 0, doneAt: null };
  // Late events (out of order) add their already-decayed share without moving the clock back.
  const late = ts < base.at;
  return {
    energy: late
      ? base.energy + energy * Math.exp(-(base.at - ts) / ACTIVITY_TAU_MS)
      : energyAt(base, ts) + energy,
    at: late ? base.at : ts,
    lastAt: Math.max(base.lastAt, ts),
    events: base.events + (event ? 1 : 0),
    doneAt: done ? Math.max(base.doneAt ?? ts, ts) : base.doneAt,
  };
}

/** Copy-on-write accumulator, so untouched pulses keep their identity. */
class PulseWriter {
  private next: Record<string, Pulse> | null = null;

  constructor(private readonly current: Pulses) {}

  add(key: string, change: Bump): void {
    this.next ??= { ...this.current };
    this.next[key] = bump(this.next[key], change);
  }

  result(): Pulses {
    return this.next ?? this.current;
  }
}

/** The terminal and its project for an event; hook events name only the session. */
function owners(event: ActivityEvent, board: BoardState): string[] {
  const keys: string[] = [];
  const session = event.sessionId ? board.sessions[event.sessionId] : undefined;
  const terminal = event.terminalId ? board.terminals[event.terminalId] : undefined;
  const projectId = event.projectId ?? session?.projectId ?? terminal?.projectId ?? null;
  if (projectId) keys.push(activityKey.project(projectId));
  if (event.sessionId) keys.push(activityKey.session(event.sessionId));
  if (event.terminalId) keys.push(activityKey.terminal(event.terminalId));
  return keys;
}

/** Feeds activity events into the pulses. Events from the future count as now. */
export function ingestEvents(
  pulses: Pulses,
  events: readonly ActivityEvent[],
  board: BoardState,
  now: number,
): Pulses {
  const writer = new PulseWriter(pulses);
  for (const event of events) {
    if (event.kind === 'unknown') continue;
    const ts = Math.min(event.ts, now);
    const done = event.kind === 'stop';
    for (const key of owners(event, board)) writer.add(key, { energy: 1, ts, event: true, done });
  }
  return writer.result();
}

/** Turns output growth between two boards (one patch) into terminal and project energy. */
export function ingestOutput(
  pulses: Pulses,
  before: BoardState,
  after: BoardState,
  ops: readonly PatchOp[],
  now: number,
): Pulses {
  if (before.executions === after.executions) return pulses;
  const writer = new PulseWriter(pulses);
  const seen = new Set<string>();
  for (const op of ops) {
    if (op.path[0] !== 'executions' || op.path.length < 2) continue;
    const id = op.path[1] as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const next = after.executions[id];
    if (!next) continue;
    const grown = next.outputBytes - (before.executions[id]?.outputBytes ?? 0);
    if (grown <= 0) continue;
    const energy = Math.min(MAX_OUTPUT_ENERGY, grown * BYTE_ENERGY);
    writer.add(activityKey.terminal(next.terminalId), { energy, ts: now });
    const projectId = after.terminals[next.terminalId]?.projectId;
    if (projectId) writer.add(activityKey.project(projectId), { energy, ts: now });
  }
  return writer.result();
}
