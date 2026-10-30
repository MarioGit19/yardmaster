import {
  type BoardState,
  type ClaudeSession,
  isBoardTerminal,
  LONG_COMMAND_MS,
  type SeenResponse,
  type StatusToken,
  sessionSilent,
  sessionStatusToken,
  type Terminal,
  terminalStatusToken,
} from '@yardmaster/protocol';
import { useEffect } from 'react';
import { useNow } from './anim/clock.js';
import { runningBackground } from './background/model.js';
import { activityKey, type Pulses } from './data/activity.js';
import { useBoard, useBoardList, useBoardStore } from './data/index.js';
import { isCrashExit } from './data/selectors.js';
import type { BoardStoreState, ConnectionStatus } from './data/store.js';
import { type LaneView, laneExecution, laneView } from './lanes/lane.js';
import { seenItems, useSeenItems } from './seen.js';
import { rankTone, type StatusView, sessionStatusView, type Tone } from './status.js';

/** How often a status re-checks its silence timers. */
export const STALE_TICK_MS = 15_000;

/** Everything the tokens need beyond the session or terminal itself. */
export interface StatusContext {
  board: Pick<BoardState, 'windows' | 'executions'>;
  pulses: Pulses;
  /** The board still hears from the server. */
  live: boolean;
  seen: SeenResponse;
  now: number;
}

/** False once a connection dropped; the first connect has no board to distrust yet. */
export const hearsServer = (status: ConnectionStatus | undefined) =>
  status !== 'reconnecting' && status !== 'stopped';

/** Without a browser's record nothing counts as news. */
export const NOTHING_NEW: SeenResponse = { since: Number.MAX_SAFE_INTEGER, marks: {} };

export const statusContext = (
  s: Pick<BoardStoreState, 'board' | 'pulses'> & Partial<Pick<BoardStoreState, 'connection'>>,
  seen: SeenResponse,
  now: number,
): StatusContext => {
  return {
    board: s.board,
    pulses: s.pulses,
    live: hearsServer(s.connection?.status),
    seen,
    now,
  };
};

export const seenKey = {
  session: (id: string) => `s:${id}`,
  terminal: (id: string) => `t:${id}`,
};

function isUnseen(seen: SeenResponse, key: string, doneAt: number | null | undefined): boolean {
  if (doneAt == null || doneAt <= seen.since) return false;
  return doneAt > (seen.marks[key] ?? 0);
}

/** A terminal's editor window is gone: its command may have ended without the board hearing. */
const windowGone = (ctx: StatusContext, terminal: Pick<Terminal, 'windowId' | 'origin'>) =>
  !isBoardTerminal(terminal) && ctx.board.windows[terminal.windowId] === undefined;

/** Why a session can't be trusted right now, in words, or null when it can. */
export function sessionStaleReason(session: ClaudeSession, ctx: StatusContext): string | null {
  if (!ctx.live) return 'Connection lost';
  const pulse = ctx.pulses[activityKey.session(session.id)]?.lastAt ?? 0;
  if (sessionSilent(session.status.kind, Math.max(session.updatedAt, pulse), ctx.now)) {
    return 'No updates from this session';
  }
  return null;
}

export function sessionToken(session: ClaudeSession, ctx: StatusContext): StatusToken {
  return sessionStatusToken(session.status.kind, {
    background: runningBackground(session) > 0,
    unseen: isUnseen(ctx.seen, seenKey.session(session.id), session.lastAssistantAt),
    stale: sessionStaleReason(session, ctx) !== null,
  });
}

export function terminalStaleReason(terminal: Terminal, ctx: StatusContext): string | null {
  if (!ctx.live) return 'Connection lost';
  return windowGone(ctx, terminal) ? 'Editor window gone' : null;
}

export function terminalToken(
  terminal: Terminal,
  execution: { startedAt: number | null; endedAt: number | null },
  lane: Pick<LaneView, 'running' | 'exit'>,
  ctx: StatusContext,
): StatusToken {
  const { endedAt, startedAt } = execution;
  const long = endedAt != null && startedAt != null && endedAt - startedAt >= LONG_COMMAND_MS;
  return terminalStatusToken({
    state: terminal.state,
    running: lane.running,
    failed: isCrashExit(lane.exit?.code),
    unseen:
      long && lane.exit?.code === 0 && isUnseen(ctx.seen, seenKey.terminal(terminal.id), endedAt),
    stale: terminalStaleReason(terminal, ctx) !== null,
  });
}

/** The tone a token draws with. Running keeps the work/tool distinction its caller knows. */
export function tokenTone(token: StatusToken, running: Tone = 'work'): Tone {
  switch (token) {
    case 'needs_you':
      return 'wait';
    case 'failed':
      return 'err';
    case 'running':
      return running;
    case 'stale':
      return 'stale';
    case 'done_unseen':
      return 'ok';
    case 'quiet':
      return 'idle';
  }
}

/** A session's status with what this device knows on top: stale, or done and not yet opened. */
export function sessionView(session: ClaudeSession, ctx: StatusContext): StatusView {
  const view = sessionStatusView(session.status);
  const token = sessionToken(session, ctx);
  if (token === 'stale') return { tone: 'stale', label: 'Stale' };
  if (token === 'done_unseen') return { tone: 'ok', label: 'Done, unseen' };
  if (token === 'running' && view.tone === 'idle') return { tone: 'work', label: 'Running' };
  return view;
}

/** The most urgent tone among a project's sessions and terminals. */
export function projectStatusTone(
  sessions: readonly ClaudeSession[],
  terminals: readonly Terminal[],
  ctx: StatusContext,
): Tone {
  let best: Tone = 'idle';
  for (const session of sessions) best = rankTone(best, tokenTone(sessionToken(session, ctx)));
  for (const terminal of terminals) {
    const execution = laneExecution({ executions: ctx.board.executions }, terminal);
    const lane = laneView(terminal, execution, '');
    best = rankTone(best, tokenTone(terminalToken(terminal, execution, lane, ctx)));
    // A closed terminal's own non-zero exit, Ctrl+C or not, still marks the project.
    if (terminal.exitCode !== null && terminal.exitCode !== 0) best = rankTone(best, 'err');
  }
  return best;
}

/** `projectStatusTone` as a primitive, so a pod only re-renders when its tone changes. */
export function useProjectTone(
  sessions: readonly ClaudeSession[],
  terminals: readonly Terminal[],
): Tone {
  const seen = useSeenItems();
  const now = useNow(STALE_TICK_MS);
  return useBoard((s) => projectStatusTone(sessions, terminals, statusContext(s, seen, now)));
}

/** Reads the status context on demand, for a row whose session or terminal may not exist. */
export function useStatusReader(): () => StatusContext {
  const seen = useSeenItems();
  const now = useNow(STALE_TICK_MS);
  const store = useBoardStore();
  useBoard((s) => s.connection.status);
  return () => statusContext(store.getState(), seen, now);
}

export function useSessionView(session: ClaudeSession): StatusView {
  const seen = useSeenItems();
  const now = useNow(STALE_TICK_MS);
  const tone = useBoard((s) => sessionView(session, statusContext(s, seen, now)).tone);
  const label = useBoard((s) => sessionView(session, statusContext(s, seen, now)).label);
  return { tone, label };
}

/** A terminal's lane with its token applied: stale instead of a frozen "running". */
export function useLaneStatus(terminal: Terminal, lane: LaneView): LaneView {
  const seen = useSeenItems();
  const now = useNow(STALE_TICK_MS);
  const token = useBoard((s) => {
    const execution = laneExecution(s.board, terminal);
    return terminalToken(terminal, execution, lane, statusContext(s, seen, now));
  });
  return laneWithToken(lane, token);
}

export function laneWithToken(lane: LaneView, token: StatusToken): LaneView {
  if (token === 'stale') {
    return { ...lane, tone: 'stale', label: lane.label.replace(/running$/, 'stale') };
  }
  return token === 'done_unseen' ? { ...lane, tone: 'ok' } : lane;
}

/** What finished in a project and is still unopened, as `key|doneAt`. */
function selectUnseen(projectId: string, seen: SeenResponse) {
  return (s: BoardStoreState): string[] => {
    const items: string[] = [];
    const add = (key: string, doneAt: number | null | undefined) => {
      if (isUnseen(seen, key, doneAt)) items.push(`${key}|${doneAt}`);
    };
    for (const session of Object.values(s.board.sessions)) {
      if (session.projectId === projectId) {
        add(seenKey.session(session.id), session.lastAssistantAt);
      }
    }
    for (const terminal of Object.values(s.board.terminals)) {
      if (terminal.projectId === projectId) {
        add(seenKey.terminal(terminal.id), laneExecution(s.board, terminal).endedAt);
      }
    }
    return items;
  };
}

/** An open project has been seen, and so has whatever finishes while it stays on screen. */
export function useMarkProjectSeen(projectId: string): void {
  const unseen = useBoardList(selectUnseen(projectId, useSeenItems()));
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState !== 'visible') return;
      for (const item of unseen) {
        const split = item.lastIndexOf('|');
        seenItems.mark(item.slice(0, split), Number(item.slice(split + 1)));
      }
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [unseen]);
}
