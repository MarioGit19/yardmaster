import type { ClaudeSession, SeenResponse, Terminal } from '@yardmaster/protocol';
import { terminalSession } from '../data/selectors.js';
import type { BoardStoreState } from '../data/store.js';
import { type LaneView, laneView, selectLaneExecution } from '../lanes/lane.js';
import { type Tone, totalTokens } from '../status.js';
import {
  NOTHING_NEW,
  type StatusContext,
  sessionToken,
  statusContext,
  terminalToken,
} from '../statusTokens.js';

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

function sessionBucket(session: ClaudeSession, ctx: StatusContext): HudBucket | null {
  switch (sessionToken(session, ctx)) {
    case 'needs_you':
      return 'needsYou';
    case 'failed':
      return 'failed';
    case 'running':
      return 'active';
    default:
      return null;
  }
}

function terminalBucket(
  s: BoardStoreState,
  terminal: Terminal,
  lane: LaneView,
  ctx: StatusContext,
): HudBucket | null {
  if (lane.running) {
    // `claude` running in a terminal is that session: it counts once, by the session's own state.
    if (terminalSession(s.board, terminal.id)) return null;
    const execution = selectLaneExecution(terminal)(s);
    return terminalToken(terminal, execution, lane, ctx) === 'running' ? 'active' : null;
  }
  const opened = lane.exit && ctx.seen.marks[lane.exit.key] !== undefined;
  return lane.tone === 'err' && lane.exit && !opened ? 'failed' : null;
}

/** A flat object of numbers: pair it with a shallow compare (`useBoardShallow`). */
export const selectHudCounts =
  (now: () => number = Date.now, seen: SeenResponse = NOTHING_NEW) =>
  (s: BoardStoreState): HudCounts => {
    const counts: HudCounts = { needsYou: 0, failed: 0, active: 0, tokensToday: 0 };
    const at = now();
    const since = startOfLocalDay(at);
    const ctx = statusContext(s, seen, at);
    for (const session of Object.values(s.board.sessions)) {
      const bucket = sessionBucket(session, ctx);
      if (bucket) counts[bucket]++;
      if (session.updatedAt >= since) counts.tokensToday += totalTokens(session);
    }
    for (const terminal of Object.values(s.board.terminals)) {
      const lane = laneView(terminal, selectLaneExecution(terminal)(s));
      const bucket = terminalBucket(s, terminal, lane, ctx);
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
  (bucket: HudBucket, seen: SeenResponse = NOTHING_NEW, now: () => number = Date.now) =>
  (s: BoardStoreState): HudItem[] => {
    const items: HudItem[] = [];
    const ctx = statusContext(s, seen, now());
    for (const session of Object.values(s.board.sessions)) {
      if (sessionBucket(session, ctx) === bucket) items.push({ kind: 'session', session });
    }
    for (const terminal of Object.values(s.board.terminals)) {
      const lane = laneView(terminal, selectLaneExecution(terminal)(s));
      if (terminalBucket(s, terminal, lane, ctx) === bucket) {
        items.push({ kind: 'terminal', terminal, lane });
      }
    }
    return items;
  };
