import type { ClaudeSession, Terminal } from '@yardmaster/protocol';
import { runningBackground } from '../background/model.js';
import { terminalSession } from '../data/selectors.js';
import type { BoardStoreState } from '../data/store.js';
import { type LaneView, laneView, selectLaneExecution } from '../lanes/lane.js';
import { type Tone, totalTokens } from '../status.js';

export interface HudCounts {
  /** Sessions blocked on an approval, a question or a reply. */
  needsYou: number;
  /** Failed sessions plus terminals that exited non-zero and this browser hasn't opened since. */
  failed: number;
  /** Busy sessions (idle ones with background work included) and terminals running a command. */
  active: number;
  /** Tokens of the sessions active since local midnight. */
  tokensToday: number;
}

export type HudBucket = 'needsYou' | 'failed' | 'active';

export function startOfLocalDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function sessionBucket(session: ClaudeSession): HudBucket | null {
  switch (session.status.kind) {
    case 'working':
    case 'tool':
    case 'compacting':
      return 'active';
    case 'waiting_permission':
    case 'waiting_input':
      return 'needsYou';
    case 'error':
      return 'failed';
    case 'ended':
    case 'interrupted':
      return null;
    default:
      // Idle, but a watcher or subagent still runs: that is work going on.
      return runningBackground(session) > 0 ? 'active' : null;
  }
}

function terminalBucket(
  s: BoardStoreState,
  terminal: Terminal,
  lane: LaneView,
  seen: ReadonlySet<string>,
): HudBucket | null {
  if (lane.running) {
    // `claude` running in a terminal is that session: it counts once, by the session's own state.
    return terminalSession(s.board, terminal.id) ? null : 'active';
  }
  return lane.tone === 'err' && lane.exit && !seen.has(lane.exit.key) ? 'failed' : null;
}

const NOTHING_SEEN: ReadonlySet<string> = new Set();

/** A flat object of numbers: pair it with a shallow compare (`useBoardShallow`). */
export const selectHudCounts =
  (now: () => number = Date.now, seen: ReadonlySet<string> = NOTHING_SEEN) =>
  (s: BoardStoreState): HudCounts => {
    const counts: HudCounts = { needsYou: 0, failed: 0, active: 0, tokensToday: 0 };
    const since = startOfLocalDay(now());
    for (const session of Object.values(s.board.sessions)) {
      const bucket = sessionBucket(session);
      if (bucket) counts[bucket]++;
      if (session.updatedAt >= since) counts.tokensToday += totalTokens(session);
    }
    for (const terminal of Object.values(s.board.terminals)) {
      const lane = laneView(terminal, selectLaneExecution(terminal)(s));
      const bucket = terminalBucket(s, terminal, lane, seen);
      if (bucket) counts[bucket]++;
    }
    return counts;
  };

/** The most severe bucket with anything in it: it colours the whole counter group. */
export function hudSeverity(counts: Pick<HudCounts, HudBucket>): Tone | null {
  if (counts.needsYou > 0) return 'wait';
  if (counts.failed > 0) return 'err';
  return counts.active > 0 ? 'work' : null;
}

export type HudItem =
  | { kind: 'session'; session: ClaudeSession }
  | { kind: 'terminal'; terminal: Terminal; lane: LaneView };

/** What makes up one counter, in board order. */
export const selectHudItems =
  (bucket: HudBucket, seen: ReadonlySet<string> = NOTHING_SEEN) =>
  (s: BoardStoreState): HudItem[] => {
    const items: HudItem[] = [];
    for (const session of Object.values(s.board.sessions)) {
      if (sessionBucket(session) === bucket) items.push({ kind: 'session', session });
    }
    for (const terminal of Object.values(s.board.terminals)) {
      const lane = laneView(terminal, selectLaneExecution(terminal)(s));
      if (terminalBucket(s, terminal, lane, seen) === bucket) {
        items.push({ kind: 'terminal', terminal, lane });
      }
    }
    return items;
  };
