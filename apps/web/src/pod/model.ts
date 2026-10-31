import {
  type Approval,
  type ClaudeSession,
  isArchivedSession,
  isAutomaticSessionName,
  toolFamily,
} from '@yardmaster/protocol';
import { formatWaited, formatWhen } from '../time.js';

/** Session rows per pod before the rest collapse into a count. */
export const MAX_SESSION_ROWS = 3;
/** Longest one-line summary; the box truncates it further to fit. */
const CAPTION_MAX = 240;

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

const SESSION_RANK: Record<ClaudeSession['status']['kind'], number> = {
  waiting_permission: 5,
  waiting_input: 5,
  error: 4,
  tool: 3,
  working: 3,
  compacting: 3,
  unknown: 1,
  idle: 1,
  interrupted: 1,
  ended: 0,
};

/** Running sessions are all active now: they hold their order instead of swapping every tool. */
const lastActivity = (session: ClaudeSession) =>
  isBusy(session.status.kind) ? 0 : session.updatedAt;

/**
 * Live sessions for a list: most urgent first, so a capped list never hides one that needs you,
 * then by most recent activity.
 */
export function podSessions(sessions: readonly ClaudeSession[]): ClaudeSession[] {
  return sessions
    .filter((s) => s.status.kind !== 'ended')
    .sort(
      (a, b) =>
        SESSION_RANK[b.status.kind] - SESSION_RANK[a.status.kind] ||
        lastActivity(b) - lastActivity(a) ||
        b.startedAt - a.startedAt ||
        a.id.localeCompare(b.id),
    );
}

/** Live sessions for a scene: a seat doesn't change with activity, so nobody swaps desks. */
export function stationSessions(sessions: readonly ClaudeSession[]): ClaudeSession[] {
  return sessions
    .filter((s) => s.status.kind !== 'ended')
    .sort(
      (a, b) =>
        SESSION_RANK[b.status.kind] - SESSION_RANK[a.status.kind] ||
        b.startedAt - a.startedAt ||
        a.id.localeCompare(b.id),
    );
}

/** Finished sessions still on the lists, most recently active first. */
export function endedSessions(sessions: readonly ClaudeSession[]): ClaudeSession[] {
  return sessions
    .filter((s) => s.status.kind === 'ended' && !isArchivedSession(s))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
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
    case 'interrupted':
      return {
        glyph: null,
        text: status.turnRunning ? 'Interrupted by a board restart' : 'Stopped by a board restart',
        tone: 'rest',
      };
    case 'idle': {
      return { glyph: null, text: sessionSummary(session) ?? 'Ready', tone: 'rest' };
    }
  }
}

/**
 * What the session's last turn produced, else its title; Claude Code's automatic `<folder>-<code>`
 * name says nothing.
 */
export function sessionSummary(session: ClaudeSession): string | null {
  const title = session.title?.trim();
  const named = title && !isAutomaticSessionName(title, session.cwd) ? title : null;
  const text = lastLine(session.lastAssistantText) ?? named;
  return text ? clipCaption(text) : null;
}

const clipCaption = (text: string) =>
  text.length > CAPTION_MAX ? `${text.slice(0, CAPTION_MAX - 1)}…` : text;

/** A Running that can't be vouched for says why instead of repeating its last action. */
export const staleCaption = (reason: string): Caption => ({
  glyph: null,
  text: reason,
  tone: 'rest',
});

export interface SessionWhen {
  text: string;
  /** The moment `text` counts from, for a tooltip with the absolute time. */
  at: number;
}

/**
 * A session's time on a card: how long it has waited while blocked, how long ago it last did
 * something otherwise, and nothing while it runs, when its caption is the news.
 */
export function sessionWhen(
  session: ClaudeSession,
  approval: Approval | null | undefined,
  now: number,
): SessionWhen | null {
  const { kind } = session.status;
  if (kind === 'waiting_permission' || kind === 'waiting_input') {
    const at = approval?.createdAt ?? session.updatedAt;
    return { text: `waiting ${formatWaited(Math.max(0, now - at))}`, at };
  }
  if (isBusy(kind)) return null;
  const at = session.lastAssistantAt ?? session.updatedAt;
  return { text: formatWhen(at, now), at };
}

const isBusy = (kind: ClaudeSession['status']['kind']) =>
  kind === 'working' || kind === 'tool' || kind === 'compacting';

/**
 * The last line of the assistant's text that reads as prose, whitespace collapsed: code inside
 * fences (closed or still streaming) and bracket-only lines are skipped, and list, quote and
 * heading markers and inline backticks are dropped. A line that ends in a colon loses to any
 * other prose.
 */
export function lastLine(text: string | null): string | null {
  if (!text) return null;
  let found: string | null = null;
  let inFence = false;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = trimmed
      .replace(/^(?:[#>]+|[-*+]|\d+[.)])\s+/, '')
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line || /^[\s`#>*\-_|=~{}[\]();,.:]+$/.test(line)) continue;
    // "The fix:" only introduces what follows; it stands in when nothing else was said.
    if (found === null || !line.endsWith(':')) found = line;
  }
  return found;
}

/** The session is producing output right now (thinking or running a tool). */
export const isStreaming = (session: ClaudeSession) =>
  session.status.kind === 'working' || session.status.kind === 'tool';
