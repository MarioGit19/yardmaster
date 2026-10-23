import { runningBackground } from '../background/model.js';
import type { BoardStoreState } from '../data/store.js';
import { laneView, selectLaneExecution } from '../lanes/lane.js';
import { totalTokens } from '../status.js';

export interface HudCounts {
  /** Sessions working, or idle with background work running. */
  working: number;
  waiting: number;
  /** Terminals with a command running right now. */
  running: number;
  /** Sessions in error plus terminals whose last command (or shell) failed, as lanes show them. */
  errors: number;
  /** Tokens of the sessions active since local midnight. */
  tokensToday: number;
}

export function startOfLocalDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** A flat object of numbers: pair it with a shallow compare (`useBoardShallow`). */
export const selectHudCounts =
  (now: () => number = Date.now) =>
  (s: BoardStoreState): HudCounts => {
    const counts: HudCounts = { working: 0, waiting: 0, running: 0, errors: 0, tokensToday: 0 };
    const since = startOfLocalDay(now());
    for (const session of Object.values(s.board.sessions)) {
      switch (session.status.kind) {
        case 'working':
        case 'tool':
        case 'compacting':
          counts.working++;
          break;
        case 'waiting_permission':
        case 'waiting_input':
          counts.waiting++;
          break;
        case 'error':
          counts.errors++;
          break;
        case 'ended':
        case 'interrupted':
          break;
        default:
          // Idle, but a watcher or subagent still runs: that is work going on.
          if (runningBackground(session) > 0) counts.working++;
      }
      if (session.updatedAt >= since) counts.tokensToday += totalTokens(session);
    }
    for (const terminal of Object.values(s.board.terminals)) {
      const lane = laneView(terminal, selectLaneExecution(terminal)(s));
      if (lane.running) counts.running++;
      else if (lane.tone === 'err') counts.errors++;
    }
    return counts;
  };
