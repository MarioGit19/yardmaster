import {
  isArchivedSession,
  type SeenMarks,
  type SeenResponse,
  sessionDisplayName,
} from '@yardmaster/protocol';
import { type StripItem, selectStripItems } from '../attention/needsYou.js';
import { runningBackground } from '../background/model.js';
import { terminalSession } from '../data/selectors.js';
import type { BoardStoreState } from '../data/store.js';
import { laneView, selectLaneExecution, terminalDisplay } from '../lanes/lane.js';
import { countOf } from '../plural.js';
import { sessionCaption, sessionSummary } from '../pod/model.js';
import { sessionHref, terminalHref } from '../routes.js';
import { selectHudItems } from '../shell/counts.js';
import { seenKey, sessionToken, statusContext, terminalToken } from '../statusTokens.js';

export type RecapSection = 'needs_you' | 'failed' | 'finished' | 'running';

export interface RecapItem {
  key: string;
  section: RecapSection;
  project: string;
  name: string;
  /** The reason, the one-line outcome, or what it's doing now. */
  detail: string;
  /** When it began to wait, failed or finished. */
  at: number;
  href: string | null;
  /** A failed command, whose last lines the recap reads. */
  execId: string | null;
  /** The project's changed files, by git status, on a finished session. */
  filesChanged: number | null;
}

export type Recap = Record<RecapSection, RecapItem[]>;

export const RECAP_ORDER: readonly RecapSection[] = ['needs_you', 'failed', 'finished', 'running'];

const fromStrip =
  (s: BoardStoreState) =>
  (item: StripItem): RecapItem => {
    const terminal = item.key.startsWith('t:') ? s.board.terminals[item.key.slice(2)] : undefined;
    return {
      key: item.key,
      section: item.token,
      project: item.project,
      name: item.name,
      detail: item.reason,
      at: item.since,
      href: item.href,
      execId: terminal ? selectLaneExecution(terminal)(s).id : null,
      filesChanged: null,
    };
  };

function finishedItems(s: BoardStoreState, seen: SeenResponse, from: number, now: number) {
  const ctx = statusContext(s, seen, now);
  const after = Math.max(from, seen.since);
  const projectName = (id: string | null) => s.board.projects[id ?? '']?.name ?? 'No project';
  const items: RecapItem[] = [];
  for (const session of Object.values(s.board.sessions)) {
    const token = sessionToken(session, ctx);
    if (isArchivedSession(session) || (token !== 'done_unseen' && token !== 'quiet')) continue;
    const key = seenKey.session(session.id);
    const at = Math.max(session.lastAssistantAt ?? 0, session.endedAt ?? 0);
    if (at <= after || at <= (seen.marks[key] ?? 0)) continue;
    const { projectId, compactSummary } = session;
    const lastAssistantText = session.lastAssistantText ?? compactSummary ?? null;
    items.push({
      key,
      section: 'finished',
      project: projectName(projectId),
      name: sessionDisplayName(session),
      detail: sessionSummary({ ...session, lastAssistantText }) ?? 'Finished',
      at,
      href: projectId ? sessionHref(projectId, session.id) : null,
      execId: null,
      filesChanged: s.board.projects[projectId ?? '']?.git?.dirty ?? null,
    });
  }
  for (const terminal of Object.values(s.board.terminals)) {
    if (terminalSession(s.board, terminal.id)) continue;
    const execution = selectLaneExecution(terminal)(s);
    const lane = laneView(terminal, execution);
    const key = seenKey.terminal(terminal.id);
    const at = execution.endedAt;
    if (terminalToken(terminal, execution, lane, ctx) !== 'done_unseen' || at === null) continue;
    if (at <= after) continue;
    items.push({
      key,
      section: 'finished',
      project: projectName(terminal.projectId),
      name: terminalDisplay(terminal, execution).name,
      detail: `${lane.command ?? 'Command'} finished`,
      at,
      href: terminal.projectId ? terminalHref(terminal.projectId, terminal.id) : null,
      execId: null,
      filesChanged: null,
    });
  }
  return items.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

function runningItems(s: BoardStoreState, seen: SeenResponse, now: number): RecapItem[] {
  const projectName = (id: string | null) => s.board.projects[id ?? '']?.name ?? 'No project';
  return selectHudItems(
    'active',
    seen,
    () => now,
  )(s).map((item) => {
    if (item.kind === 'session') {
      const { session } = item;
      const tasks = runningBackground(session);
      return {
        key: seenKey.session(session.id),
        section: 'running',
        project: projectName(session.projectId),
        name: sessionDisplayName(session),
        detail:
          session.status.kind === 'idle' && tasks > 0
            ? `${countOf(tasks, 'background task')} running`
            : sessionCaption(session).text,
        at: session.startedAt,
        href: session.projectId ? sessionHref(session.projectId, session.id) : null,
        execId: null,
        filesChanged: null,
      };
    }
    const { terminal, lane } = item;
    return {
      key: seenKey.terminal(terminal.id),
      section: 'running',
      project: projectName(terminal.projectId),
      name: terminalDisplay(terminal, selectLaneExecution(terminal)(s)).name,
      detail: lane.command ?? 'Running',
      at: terminal.createdAt,
      href: terminal.projectId ? terminalHref(terminal.projectId, terminal.id) : null,
      execId: null,
      filesChanged: null,
    };
  });
}

/**
 * Everything to say on return, built from what the board already holds. Needs you and failed are
 * whatever is open now, whenever it began; finished is what ended after `from` and is unopened.
 */
export const selectRecap =
  (seen: SeenResponse, from: number, now: number) =>
  (s: BoardStoreState): Recap => {
    const strip = selectStripItems(seen, now)(s);
    const toItem = fromStrip(s);
    return {
      needs_you: strip.filter((item) => item.token === 'needs_you').map(toItem),
      failed: strip.filter((item) => item.token === 'failed').map(toItem),
      finished: finishedItems(s, seen, from, now),
      running: runningItems(s, seen, now),
    };
  };

/** Whether something happened in the window: work merely still running isn't news. */
export function hasNews(recap: Recap, from: number, to: number): boolean {
  const items = [...recap.needs_you, ...recap.failed, ...recap.finished];
  return items.some((item) => item.at > from && item.at <= to);
}

export const isEmptyRecap = (recap: Recap) => RECAP_ORDER.every((key) => recap[key].length === 0);

/**
 * What "Mark all seen" marks: every Done, unseen dot plus the recap's finished rows. Failures
 * aren't dots, and stay until opened; waiting sessions aren't touched.
 */
export const selectDotMarks =
  (seen: SeenResponse, from: number, now: number) =>
  (s: BoardStoreState): SeenMarks => {
    const ctx = statusContext(s, seen, now);
    const marks: SeenMarks = {};
    for (const item of finishedItems(s, seen, from, now)) marks[item.key] = item.at;
    for (const session of Object.values(s.board.sessions)) {
      if (session.lastAssistantAt == null || sessionToken(session, ctx) !== 'done_unseen') continue;
      marks[seenKey.session(session.id)] = session.lastAssistantAt;
    }
    for (const terminal of Object.values(s.board.terminals)) {
      const execution = selectLaneExecution(terminal)(s);
      const lane = laneView(terminal, execution);
      if (execution.endedAt === null) continue;
      if (terminalToken(terminal, execution, lane, ctx) !== 'done_unseen') continue;
      marks[seenKey.terminal(terminal.id)] = execution.endedAt;
    }
    return marks;
  };
