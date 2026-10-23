import {
  type ActivityEvent,
  type BoardState,
  type ClaudeSession,
  PULSE_WINDOW_MS,
} from '@c-board/protocol';
import { terminalSession } from '../data/selectors.js';
import { projectHref, sessionHref } from '../routes.js';
import type { Tone } from '../status.js';

/** The Pulse rail's data model (DESIGN.md §4.7): lanes, colors, layout and hit-testing. */

export const PULSE_FILTERS = ['all', 'claude', 'terminals', 'errors'] as const;
export type PulseFilter = (typeof PULSE_FILTERS)[number];

export const FILTER_LABEL: Record<PulseFilter, string> = {
  all: 'All',
  claude: 'Claude',
  terminals: 'Terminals',
  errors: 'Errors',
};

/** Ctrl+C in a shell. Interrupting a command is not a failure. */
const INTERRUPTED_EXIT = 130;

export function exitCodeOf(event: ActivityEvent): number | null {
  const code = event.data.exitCode;
  return typeof code === 'number' && Number.isInteger(code) ? code : null;
}

export const isTerminalEvent = (event: ActivityEvent) =>
  event.kind === 'exec.start' || event.kind === 'exec.end';

/** The event's color, using the status tokens so a dot reads the same as the rest of the board. */
export function eventTone(event: ActivityEvent): Tone {
  switch (event.kind) {
    case 'tool.error':
    case 'stop.failure':
      return 'err';
    case 'exec.end': {
      const code = exitCodeOf(event);
      if (code === null || code === 0) return 'ok';
      return code === INTERRUPTED_EXIT ? 'idle' : 'err';
    }
    case 'permission.request':
    case 'notification':
      return 'wait';
    case 'stop':
      return 'ok';
    case 'background.end': {
      const status = event.data.status;
      return status === 'error' ? 'err' : status === 'stopped' ? 'idle' : 'ok';
    }
    case 'background.start':
    case 'tool.start':
    case 'tool.end':
    case 'subagent.start':
    case 'subagent.stop':
      return 'tool';
    case 'prompt':
    case 'session.start':
    case 'compact.start':
    case 'compact.end':
    case 'exec.start':
    case 'permission.decision':
      return 'work';
    case 'session.end':
    case 'unknown':
      return 'idle';
  }
}

export function eventLabel(event: ActivityEvent): string {
  switch (event.kind) {
    case 'session.start':
      return 'Session started';
    case 'session.end':
      return 'Session ended';
    case 'prompt':
      return 'Prompt';
    case 'tool.start':
      return 'Tool started';
    case 'tool.end':
      return 'Tool finished';
    case 'tool.error':
      return 'Tool failed';
    case 'notification':
      return 'Notification';
    case 'permission.request':
      return 'Needs approval';
    case 'permission.decision':
      return 'Approval decided';
    case 'stop':
      return 'Turn finished';
    case 'stop.failure':
      return 'Turn failed';
    case 'subagent.start':
      return 'Subagent started';
    case 'subagent.stop':
      return 'Subagent finished';
    // The server names the kind ("Background shell started"); never a label or command.
    case 'background.start':
      return event.summary ?? 'Background task started';
    case 'background.end':
      return event.summary ?? 'Background task finished';
    case 'compact.start':
      return 'Compacting';
    case 'compact.end':
      return 'Compacted';
    case 'exec.start':
      return 'Command started';
    case 'exec.end': {
      const code = exitCodeOf(event);
      if (code === INTERRUPTED_EXIT) return 'Interrupted';
      return code === null ? 'Command finished' : `Exited ${code}`;
    }
    case 'unknown':
      return 'Event';
  }
}

/** The line under the label; a background event's summary is its label already. */
export function eventDetail(event: ActivityEvent): string | null {
  if (event.kind === 'background.start' || event.kind === 'background.end') return null;
  return event.summary;
}

/** How many events (oldest first) are at or after `since`: the rail's window of the hour kept. */
export function countSince(events: readonly ActivityEvent[], since: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((events[mid] as ActivityEvent).ts < since) lo = mid + 1;
    else hi = mid;
  }
  return events.length - lo;
}

export function matchesFilter(event: ActivityEvent, filter: PulseFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'claude':
      return !isTerminalEvent(event);
    case 'terminals':
      return isTerminalEvent(event);
    case 'errors':
      return eventTone(event) === 'err';
  }
}

export interface PulseLane {
  /** Project id, or `null` for events of projects the board doesn't know. */
  projectId: string | null;
  name: string;
  /** Accent index (`--accent-<n>`), or null for the "Other" lane. */
  accent: number | null;
  events: ActivityEvent[];
}

/**
 * One lane per project, in the rail's order (by name), so lanes stay put while events come
 * and go. Events of unknown projects share a trailing "Other" lane that only shows when used.
 */
export function buildLanes(
  events: readonly ActivityEvent[],
  projects: BoardState['projects'],
  filter: PulseFilter,
  since: number,
): PulseLane[] {
  const lanes = Object.values(projects)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p): PulseLane => ({ projectId: p.id, name: p.name, accent: p.accent, events: [] }));
  const byId = new Map(lanes.map((lane) => [lane.projectId, lane]));
  const other: PulseLane = { projectId: null, name: 'Other', accent: null, events: [] };
  for (const event of events) {
    if (event.ts < since || !matchesFilter(event, filter)) continue;
    const lane = (event.projectId !== null && byId.get(event.projectId)) || other;
    lane.events.push(event);
  }
  if (other.events.length > 0) lanes.push(other);
  return lanes;
}

export interface PulseLayout {
  width: number;
  height: number;
  /** Width of the lane-name column. */
  labelWidth: number;
  /** x of the window's start (15 min ago). */
  plotLeft: number;
  /** x of "now"; new dots fly in from the gutter to its right. */
  plotRight: number;
  laneHeight: number;
  /** y of the first lane's top edge. */
  top: number;
  /** Height of the tick-label row under the lanes. */
  axisHeight: number;
}

export const LANE_HEIGHT = 22;
export const AXIS_HEIGHT = 18;
const LANE_TOP = 4;
const NOW_GUTTER = 20;

export function pulseHeight(laneCount: number): number {
  return LANE_TOP + Math.max(1, laneCount) * LANE_HEIGHT + AXIS_HEIGHT;
}

export function pulseLayout(width: number, laneCount: number): PulseLayout {
  const labelWidth = Math.round(Math.min(148, Math.max(84, width * 0.14)));
  return {
    width,
    height: pulseHeight(laneCount),
    labelWidth,
    plotLeft: labelWidth + 12,
    plotRight: Math.max(labelWidth + 24, width - NOW_GUTTER),
    laneHeight: LANE_HEIGHT,
    top: LANE_TOP,
    axisHeight: AXIS_HEIGHT,
  };
}

export function timeToX(ts: number, now: number, layout: PulseLayout): number {
  const span = layout.plotRight - layout.plotLeft;
  return layout.plotRight - ((now - ts) / PULSE_WINDOW_MS) * span;
}

export const laneCenter = (index: number, layout: PulseLayout) =>
  layout.top + index * layout.laneHeight + layout.laneHeight / 2;

export interface PulseDot {
  event: ActivityEvent;
  lane: number;
  x: number;
  y: number;
  tone: Tone;
}

/** Dots inside the window, per lane in time order. */
export function placeDots(lanes: readonly PulseLane[], now: number, layout: PulseLayout) {
  const dots: PulseDot[] = [];
  lanes.forEach((lane, index) => {
    const y = laneCenter(index, layout);
    for (const event of lane.events) {
      const x = timeToX(Math.min(event.ts, now), now, layout);
      if (x < layout.plotLeft) continue;
      dots.push({ event, lane: index, x, y, tone: eventTone(event) });
    }
  });
  return dots;
}

/** The dot under the pointer: the nearest one in the hovered lane, within `radius` px. */
export function hitTest(
  dots: readonly PulseDot[],
  x: number,
  y: number,
  layout: PulseLayout,
  radius = 8,
): PulseDot | null {
  const lane = Math.floor((y - layout.top) / layout.laneHeight);
  let best: PulseDot | null = null;
  let bestDistance = radius;
  for (const dot of dots) {
    if (dot.lane !== lane) continue;
    const distance = Math.abs(dot.x - x);
    // `<=`, so the newest of overlapping dots wins.
    if (distance <= bestDistance) {
      best = dot;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Keyboard movement between dots. ←/→ step through time across every lane, ↑/↓ move to the
 * nearest dot in time on the adjacent lane that has one, Home/End jump to the oldest/newest.
 * Returns the new dot's event id, or undefined when the key isn't a navigation key.
 */
export function stepDot(
  dots: readonly PulseDot[],
  currentId: string | null,
  key: string,
): string | null | undefined {
  if (dots.length === 0) return null;
  const byTime = [...dots].sort((a, b) => a.event.ts - b.event.ts || a.lane - b.lane);
  const index = byTime.findIndex((d) => d.event.id === currentId);
  const current = byTime[index];
  const newest = byTime.at(-1)?.event.id ?? null;
  switch (key) {
    case 'Home':
      return byTime[0]?.event.id ?? null;
    case 'End':
      return newest;
    case 'ArrowLeft':
      return current ? (byTime[Math.max(0, index - 1)]?.event.id ?? null) : newest;
    case 'ArrowRight':
      return current ? (byTime[Math.min(byTime.length - 1, index + 1)]?.event.id ?? null) : newest;
    case 'ArrowUp':
    case 'ArrowDown': {
      if (!current) return newest;
      const direction = key === 'ArrowUp' ? -1 : 1;
      const lanes = [...new Set(dots.map((d) => d.lane))].sort((a, b) => a - b);
      const lane = lanes[lanes.indexOf(current.lane) + direction];
      if (lane === undefined) return current.event.id;
      let best: PulseDot | null = null;
      for (const dot of dots) {
        if (dot.lane !== lane) continue;
        if (!best || Math.abs(dot.x - current.x) < Math.abs(best.x - current.x)) best = dot;
      }
      return best?.event.id ?? current.event.id;
    }
    default:
      return undefined;
  }
}

export interface PulseTarget {
  href: string;
  /** Opens this terminal in the focus view's stack. */
  terminal?: { projectId: string; terminalId: string };
}

/** The Claude session behind an event: its own, or the one running in its terminal. */
export function pulseSession(event: ActivityEvent, board: BoardState): ClaudeSession | undefined {
  const own = event.sessionId !== null ? board.sessions[event.sessionId] : undefined;
  if (own) return own;
  return event.terminalId !== null ? terminalSession(board, event.terminalId) : undefined;
}

/**
 * Where clicking an event goes: its session (a Claude terminal's included), else its terminal,
 * else its project.
 */
export function pulseTarget(event: ActivityEvent, board: BoardState): PulseTarget | null {
  const projectId = event.projectId;
  if (projectId === null || !board.projects[projectId]) return null;
  const session = pulseSession(event, board);
  if (session && session.projectId === projectId) {
    return { href: sessionHref(projectId, session.id) };
  }
  const terminal = event.terminalId !== null ? board.terminals[event.terminalId] : undefined;
  if (terminal && terminal.projectId === projectId) {
    return { href: projectHref(projectId), terminal: { projectId, terminalId: terminal.id } };
  }
  return { href: projectHref(projectId) };
}

export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes < 5 && rest > 0 ? `${minutes}m ${rest}s ago` : `${minutes}m ago`;
}
