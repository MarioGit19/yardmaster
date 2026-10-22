import { type Approval, type ClaudeSession, type Terminal, toolFamily } from '@c-board/protocol';
import type { BoardStoreState } from '../data/index.js';
import { projectTone, type Tone } from '../status.js';

/** Session rows per pod before the rest collapse into a count. */
export const MAX_SESSION_ROWS = 3;

/**
 * Pod order on the overview: projects that need you first (waiting, then errors), the rest by
 * name. Working and idle don't reorder, so pods don't shuffle on every turn.
 */
export function attentionRank(tone: Tone): number {
  return tone === 'wait' ? 2 : tone === 'err' ? 1 : 0;
}

export interface PodEntry {
  id: string;
  name: string;
  rank: number;
}

export function orderPods(entries: readonly PodEntry[]): string[] {
  return [...entries]
    .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((e) => e.id);
}

/**
 * Pods that moved ahead of a pod they used to follow between two orders: during the reorder they
 * fly over their neighbours. Pods that only close a gap left by a removed one don't count.
 */
export function risingPods(prev: readonly string[], next: readonly string[]): Set<string> {
  const kept = new Set(prev);
  const common = next.filter((id) => kept.has(id));
  const stayed = new Set(common);
  const before = new Map(prev.filter((id) => stayed.has(id)).map((id, i) => [id, i]));
  const rising = new Set<string>();
  common.forEach((id, i) => {
    if (i < (before.get(id) ?? i)) rising.add(id);
  });
  return rising;
}

/** Project ids in overview order, from one pass over the board. */
export function selectPodOrder(s: BoardStoreState): string[] {
  const sessions = new Map<string, ClaudeSession[]>();
  const terminals = new Map<string, Terminal[]>();
  const push = <T>(map: Map<string, T[]>, key: string | null, value: T) => {
    if (key === null) return;
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const session of Object.values(s.board.sessions)) push(sessions, session.projectId, session);
  for (const terminal of Object.values(s.board.terminals))
    push(terminals, terminal.projectId, terminal);
  return orderPods(
    Object.values(s.board.projects).map((p) => ({
      id: p.id,
      name: p.name,
      rank: attentionRank(projectTone(sessions.get(p.id) ?? [], terminals.get(p.id) ?? [])),
    })),
  );
}

const SESSION_RANK: Record<ClaudeSession['status']['kind'], number> = {
  waiting_permission: 5,
  waiting_input: 5,
  error: 4,
  tool: 3,
  working: 3,
  compacting: 3,
  unknown: 1,
  idle: 1,
  ended: 0,
};

/** Live sessions, most urgent first, then newest. */
export function podSessions(sessions: readonly ClaudeSession[]): ClaudeSession[] {
  return sessions
    .filter((s) => s.status.kind !== 'ended')
    .sort(
      (a, b) =>
        SESSION_RANK[b.status.kind] - SESSION_RANK[a.status.kind] ||
        b.startedAt - a.startedAt ||
        a.id.localeCompare(b.id),
    );
}

export type CaptionTone = 'active' | 'wait' | 'err' | 'rest';

export interface Caption {
  /** A one-character glyph for the action, DESIGN.md §4.10. */
  glyph: string | null;
  text: string;
  tone: CaptionTone;
}

function toolCaption(tool: string, summary: string | null): Caption {
  const s = summary?.trim() || null;
  switch (toolFamily(tool)) {
    case 'edit':
      return { glyph: '✎', text: s ? `Editing ${s}` : `Using ${tool}`, tone: 'active' };
    case 'read':
      return { glyph: '◇', text: s ? `Reading ${s}` : 'Reading', tone: 'active' };
    case 'search':
      return { glyph: '⌕', text: s ? `Searching "${s}"` : 'Searching', tone: 'active' };
    case 'bash':
      return { glyph: '▶', text: s ?? 'Running a command', tone: 'active' };
    case 'web':
      return { glyph: '↗', text: s ? `Fetching ${s}` : 'Searching the web', tone: 'active' };
    case 'task':
      return { glyph: '⑂', text: s ? `Delegating: ${s}` : 'Delegating', tone: 'active' };
    case 'todo':
      return { glyph: '☰', text: 'Updating the plan', tone: 'active' };
    default:
      return { glyph: '•', text: `Using ${tool}`, tone: 'active' };
  }
}

/** The session row's status line: the current action, what it waits for, or the last turn. */
export function sessionCaption(session: ClaudeSession, approval?: Approval | null): Caption {
  const { status, currentTool } = session;
  switch (status.kind) {
    case 'tool': {
      const summary = currentTool?.tool === status.tool ? currentTool.summary : null;
      return toolCaption(status.tool, summary);
    }
    case 'working':
      return { glyph: null, text: 'Thinking…', tone: 'active' };
    case 'compacting':
      return { glyph: null, text: 'Compacting the context', tone: 'active' };
    case 'waiting_permission': {
      const tool = approval?.tool ?? currentTool?.tool ?? null;
      const summary = currentTool && currentTool.tool === tool ? currentTool.summary : null;
      const what = tool ? `: ${tool}${summary ? `(${summary})` : ''}` : '';
      return { glyph: '!', text: `Waiting for approval${what}`, tone: 'wait' };
    }
    case 'waiting_input':
      return { glyph: '!', text: 'Waiting for your input', tone: 'wait' };
    case 'error':
      return {
        glyph: '×',
        text: status.message ? `Error: ${status.message}` : 'Error',
        tone: 'err',
      };
    case 'unknown':
      return { glyph: null, text: status.alive ? 'Running' : 'Unknown', tone: 'rest' };
    case 'ended':
      return { glyph: null, text: 'Ended', tone: 'rest' };
    case 'idle':
      return { glyph: null, text: session.title?.trim() || 'Idle', tone: 'rest' };
  }
}

/** The last non-empty line of the assistant's text, whitespace collapsed. */
export function lastLine(text: string | null): string | null {
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').replace(/\s+/g, ' ').trim();
    if (line && !/^[`#>*\-_|]+$/.test(line)) return line;
  }
  return null;
}

/** The session is producing output right now (thinking or running a tool). */
export const isStreaming = (session: ClaudeSession) =>
  session.status.kind === 'working' || session.status.kind === 'tool';
