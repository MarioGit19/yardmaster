import {
  type BoardState,
  type ClaudeSession,
  type Execution,
  type Project,
  sessionDisplayName,
  type Terminal,
  toolFamily,
} from '@c-board/protocol';
import { backgroundItems } from '../background/model.js';
import {
  type CrewTerminal,
  DONE_MS,
  type MascotState,
  mascotLabel,
  mascotStateFor,
  SLEEP_AFTER_MS,
} from '../crew/model.js';
import { activityKey, levelAt, type Pulses, QUIET_LEVEL } from '../data/activity.js';
import { isCrashExit, terminalSession } from '../data/selectors.js';
import type { BoardStoreState } from '../data/store.js';
import { laneExecution, terminalDisplay } from '../lanes/lane.js';
import { isDimmed } from '../pod/activity.js';
import {
  attentionRank,
  type Caption,
  lastLine,
  orderPods,
  podSessions,
  sessionCaption,
} from '../pod/model.js';
import { sessionHref, terminalHref } from '../routes.js';
import { projectTone, type Tone } from '../status.js';

// The scene-neutral model every layout draws (DESIGN.md §10.1): projects in attention-first
// order, each with its actors. No layout reads the store any other way, so a state can't mean
// one thing in Office and another in Grid.

export type ActorKind = 'claude' | 'subagent' | 'background' | 'terminal';

/** A terminal's state, the ops crew's (DESIGN.md §10.3). */
export type OpsState = 'idle' | 'sleeping' | 'running' | 'serving' | 'done' | 'error' | 'exited';

/** The crew states (§4.11) plus the terminals' `serving` and `exited`. */
export type ActorState = MascotState | 'serving' | 'exited';

export interface ActorLinks {
  /** Where Open goes: the focus view with this session or terminal selected. */
  href: string;
  sessionId: string | null;
  terminalId: string | null;
  /** The pending approval Allow and Deny decide. */
  approvalId: string | null;
}

/** Actor ids, for a view that knows the session or terminal but not the scene. */
export const actorId = {
  session: (sessionId: string) => `s:${sessionId}`,
  terminal: (terminalId: string) => `t:${terminalId}`,
  task: (sessionId: string, taskId: string) => `b:${sessionId}:${taskId}`,
};

export interface SceneActor {
  /** Unique on the board: `s:<session>`, `t:<terminal>`, `b:<session>:<task>`. */
  id: string;
  kind: ActorKind;
  projectId: string;
  /** The session actor a subagent or background task belongs to. */
  parentId: string | null;
  state: ActorState;
  tone: Tone;
  /** 0..1, DESIGN.md §4.10. */
  activity: number;
  label: string;
  caption: Caption;
  /** "acme-shop, Claude, waiting for approval: Bash(pnpm test)". */
  name: string;
  links: ActorLinks;
  /** When it started (session, task) or opened (terminal). */
  since: number;
  /** The tool a session is running, and since when (the Office's monitor and bookshelf trip). */
  tool: string | null;
  toolSince: number | null;
  /** A session in plan mode or writing its todo list: it stands at the whiteboard (§10.3). */
  planning: boolean;
  /** A terminal's listening ports, ascending. */
  ports: number[];
  /** When a terminal's running command started, or null. */
  runningSince: number | null;
  /** A failed command's exit code. */
  exit: number | null;
}

export interface SceneTodo {
  text: string;
  done: boolean;
}

export interface SceneCommit {
  hash: string;
  at: number;
  subject: string;
}

export interface SceneProject {
  id: string;
  name: string;
  accent: Project['accent'];
  tone: Tone;
  actors: SceneActor[];
  branch: string | null;
  /** Uncommitted files. */
  dirty: number;
  /** Every port the project's processes listen on, ascending. */
  ports: number[];
  /** The main session's todo list, or else its last assistant line (the Office whiteboard). */
  todos: SceneTodo[];
  summary: string | null;
  /** Recent commits on the branch, newest first (Transit's interchanges). */
  commits: SceneCommit[];
  /** 0..1, the project's activity level (§4.10). */
  activity: number;
  /** Nothing for five minutes: the pod dims, the Office's ceiling light goes down. */
  dim: boolean;
}

export interface SceneModel {
  projects: SceneProject[];
  /** Every actor by id, for an inspector that only knows the id. */
  actors: ReadonlyMap<string, SceneActor>;
}

type Exec = Pick<Execution, 'startedAt' | 'endedAt' | 'exitCode'>;

export interface OpsStateOptions {
  now?: number;
  /** A port is bound by the terminal's process. */
  listening?: boolean;
  /** When the terminal last wrote, from its activity level. */
  lastOutputAt?: number | null;
}

/**
 * A terminal's ops state from its newest execution (`executions` newest first, or any order:
 * the newest by `startedAt` wins). A running command that listens on a port is `serving`; a
 * failed one (not Ctrl+C) is `error` until something else runs; a clean exit plays `done` once.
 */
export function opsStateFor(
  terminal: Pick<Terminal, 'state' | 'createdAt' | 'closedAt'>,
  executions: readonly Exec[],
  { now = Date.now(), listening = false, lastOutputAt = null }: OpsStateOptions = {},
): OpsState {
  if (terminal.state === 'closed') return 'exited';
  let newest: Exec | null = null;
  for (const execution of executions) {
    if (!newest || execution.startedAt > newest.startedAt) newest = execution;
  }
  if (newest && newest.endedAt === null) return listening ? 'serving' : 'running';
  if (newest && isCrashExit(newest.exitCode)) return 'error';
  if (newest?.endedAt != null && newest.exitCode === 0 && now - newest.endedAt < DONE_MS) {
    return 'done';
  }
  const last = Math.max(terminal.createdAt, newest?.endedAt ?? 0, lastOutputAt ?? 0);
  return now - last >= SLEEP_AFTER_MS ? 'sleeping' : 'idle';
}

const STATE_TONE: Record<ActorState, Tone> = {
  sleeping: 'idle',
  idle: 'idle',
  watching: 'idle',
  thinking: 'work',
  typing: 'tool',
  reading: 'tool',
  running: 'tool',
  delegating: 'tool',
  waiting: 'wait',
  error: 'err',
  done: 'ok',
  serving: 'ok',
  exited: 'idle',
};

export const actorTone = (state: ActorState): Tone => STATE_TONE[state];

/** Attention first: waiting, errors, then work, then rest. */
const STATE_RANK: Record<ActorState, number> = {
  waiting: 5,
  error: 4,
  thinking: 3,
  typing: 3,
  reading: 3,
  running: 3,
  delegating: 3,
  serving: 2,
  done: 2,
  watching: 1,
  idle: 1,
  sleeping: 0,
  exited: 0,
};

export const actorRank = (state: ActorState) => STATE_RANK[state];

const KIND_ORDER: Record<ActorKind, number> = {
  claude: 0,
  subagent: 1,
  background: 2,
  terminal: 3,
};

const KIND_NAME: Record<ActorKind, string> = {
  claude: 'Claude',
  subagent: 'Subagent',
  background: 'Background task',
  terminal: 'Terminal',
};

export const actorKindName = (kind: ActorKind) => KIND_NAME[kind];

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function actorName(project: string, label: string, kind: ActorKind, caption: Caption): string {
  const what =
    kind === 'claude' || label === KIND_NAME[kind] ? label : `${KIND_NAME[kind]} ${label}`;
  return `${project}, ${what}, ${lowerFirst(caption.text)}`;
}

function terminalCaption(state: OpsState, command: string | null, exit: number | null): Caption {
  switch (state) {
    case 'running':
      return { glyph: '▶', text: command ?? 'Running a command', tone: 'active' };
    case 'serving':
      return { glyph: '▶', text: command ? `Serving: ${command}` : 'Serving', tone: 'active' };
    case 'error':
      return {
        glyph: '×',
        text: `Failed${exit !== null ? ` with exit ${exit}` : ''}${command ? `: ${command}` : ''}`,
        tone: 'err',
      };
    case 'done':
      return { glyph: '✓', text: command ? `Finished: ${command}` : 'Finished', tone: 'rest' };
    case 'exited':
      return { glyph: null, text: 'Closed', tone: 'rest' };
    case 'sleeping':
    case 'idle':
      return { glyph: null, text: command ? `Idle, last ran ${command}` : 'Idle', tone: 'rest' };
  }
}

const NO_EXTRAS = {
  tool: null,
  toolSince: null,
  planning: false,
  ports: [] as number[],
  runningSince: null,
  exit: null,
} satisfies Partial<SceneActor>;

function sessionExtras(session: ClaudeSession) {
  const current = session.currentTool?.status === 'running' ? session.currentTool : null;
  const tool = current?.tool ?? (session.status.kind === 'tool' ? session.status.tool : null);
  return {
    ...NO_EXTRAS,
    tool,
    toolSince: current?.startedAt ?? null,
    planning: session.permissionMode === 'plan' || (tool !== null && toolFamily(tool) === 'todo'),
  };
}

/** Listening ports by terminal, ascending. */
function terminalPorts(board: BoardState): Map<string, number[]> {
  const ports = new Map<string, number[]>();
  for (const binding of Object.values(board.ports)) {
    if (!binding.terminalId) continue;
    const list = ports.get(binding.terminalId) ?? [];
    if (!list.includes(binding.port)) list.push(binding.port);
    ports.set(binding.terminalId, list);
  }
  for (const list of ports.values()) list.sort((a, b) => a - b);
  return ports;
}

interface Group {
  sessions: ClaudeSession[];
  terminals: Terminal[];
}

const level = (pulses: Pulses, key: string, now: number) => levelAt(pulses[key], now);

/** Builds one project's actors: its live sessions with their running work, then its terminals. */
function projectActors(
  board: BoardState,
  pulses: Pulses,
  project: Project,
  group: Group,
  now: number,
): SceneActor[] {
  const crew: CrewTerminal[] = group.terminals.map((t) => {
    const pulse = pulses[activityKey.terminal(t.id)];
    return {
      state: t.state,
      createdAt: t.createdAt,
      closedAt: t.closedAt,
      streaming: levelAt(pulse, now) >= QUIET_LEVEL,
      lastOutputAt: pulse?.lastAt ?? null,
    };
  });
  const tops: { actor: SceneActor; children: SceneActor[] }[] = [];
  // Terminals running Claude Code are drawn as their session.
  const claudeTerminals = new Set<string>();

  for (const session of podSessions(group.sessions)) {
    if (session.terminalId && session.origin === 'terminal')
      claudeTerminals.add(session.terminalId);
    const approvalId =
      session.status.kind === 'waiting_permission' ? session.status.approvalId : null;
    const approval = approvalId ? board.approvals[approvalId] : undefined;
    const pending = approval?.state === 'pending' ? approval : null;
    const state = mascotStateFor(session, crew, { now });
    const caption = sessionCaption(session, pending);
    const label = sessionDisplayName(session);
    const id = actorId.session(session.id);
    const activity = level(pulses, activityKey.session(session.id), now);
    const links: ActorLinks = {
      href: sessionHref(project.id, session.id),
      sessionId: session.id,
      terminalId:
        session.terminalId && board.terminals[session.terminalId]?.state === 'open'
          ? session.terminalId
          : null,
      approvalId: pending?.id ?? null,
    };
    const children: SceneActor[] = [];
    for (const item of backgroundItems(session)) {
      if (item.status !== 'running') continue;
      const kind: ActorKind = item.kind === 'agent' ? 'subagent' : 'background';
      const childCaption: Caption = {
        glyph: kind === 'subagent' ? '⑂' : '▶',
        text:
          item.tail?.trim().split('\n').at(-1)?.trim() ||
          (kind === 'subagent' ? 'Working on it' : 'Running in the background'),
        tone: 'active',
      };
      children.push({
        id: actorId.task(session.id, item.id),
        kind,
        projectId: project.id,
        parentId: id,
        state: kind === 'subagent' ? 'thinking' : 'running',
        tone: kind === 'subagent' ? 'work' : 'tool',
        activity,
        label: item.label,
        caption: childCaption,
        name: actorName(project.name, item.label, kind, childCaption),
        links: { ...links, approvalId: null },
        since: item.startedAt,
        ...NO_EXTRAS,
      });
    }
    tops.push({
      actor: {
        id,
        kind: 'claude',
        projectId: project.id,
        parentId: null,
        state,
        tone: actorTone(state),
        activity,
        label,
        caption,
        name: actorName(project.name, label, 'claude', caption),
        links,
        since: session.startedAt,
        ...sessionExtras(session),
      },
      children,
    });
  }

  const ports = terminalPorts(board);

  for (const terminal of group.terminals) {
    if (terminal.state !== 'open' || claudeTerminals.has(terminal.id)) continue;
    // A Claude terminal whose session isn't on the board as a project session still reads as one.
    if (terminalSession(board, terminal.id)) continue;
    const executions: Execution[] = [];
    for (const execId of terminal.executionIds) {
      const execution = board.executions[execId];
      if (execution) executions.push(execution);
    }
    const pulse = pulses[activityKey.terminal(terminal.id)];
    const state = opsStateFor(terminal, executions, {
      now,
      listening: ports.has(terminal.id),
      lastOutputAt: pulse?.lastAt ?? null,
    });
    const last = laneExecution(board, terminal);
    const label = terminalDisplay(terminal, last).name;
    const command = last.commandLine?.trim() || null;
    const caption = terminalCaption(state, command, last.exitCode);
    let running: Execution | null = null;
    for (const execution of executions) {
      if (execution.endedAt === null && (!running || execution.startedAt > running.startedAt))
        running = execution;
    }
    tops.push({
      actor: {
        id: actorId.terminal(terminal.id),
        kind: 'terminal',
        projectId: project.id,
        parentId: null,
        state,
        tone: actorTone(state),
        activity: levelAt(pulse, now),
        label,
        caption,
        name: actorName(project.name, label, 'terminal', caption),
        links: {
          href: terminalHref(project.id, terminal.id),
          sessionId: null,
          terminalId: terminal.id,
          approvalId: null,
        },
        since: terminal.createdAt,
        ...NO_EXTRAS,
        ports: ports.get(terminal.id) ?? [],
        runningSince: running?.startedAt ?? null,
        exit: state === 'error' ? last.exitCode : null,
      },
      children: [],
    });
  }

  tops.sort(
    (a, b) =>
      actorRank(b.actor.state) - actorRank(a.actor.state) ||
      KIND_ORDER[a.actor.kind] - KIND_ORDER[b.actor.kind] ||
      a.actor.since - b.actor.since ||
      a.actor.id.localeCompare(b.actor.id),
  );
  // Running work stays beside the session it belongs to.
  return tops.flatMap(({ actor, children }) => [actor, ...children]);
}

function groupByProject(board: BoardState): Map<string, Group> {
  const groups = new Map<string, Group>();
  const group = (id: string) => {
    let found = groups.get(id);
    if (!found) {
      found = { sessions: [], terminals: [] };
      groups.set(id, found);
    }
    return found;
  };
  for (const session of Object.values(board.sessions)) {
    if (session.projectId !== null) group(session.projectId).sessions.push(session);
  }
  for (const terminal of Object.values(board.terminals)) {
    if (terminal.projectId !== null) group(terminal.projectId).terminals.push(terminal);
  }
  return groups;
}

const EMPTY: Group = { sessions: [], terminals: [] };

/**
 * The scene model for the board at `now`. Projects come in the overview's order (waiting, then
 * errors, then by name); actors inside a project attention first.
 */
/** The terminal's newest command failed (`selectCrashedCount`'s rule). */
function crashedTerminal(board: BoardState, terminal: Terminal): boolean {
  for (let i = terminal.executionIds.length - 1; i >= 0; i--) {
    const execution = board.executions[terminal.executionIds[i] ?? ''];
    if (execution) return execution.endedAt !== null && isCrashExit(execution.exitCode);
  }
  return false;
}

/** One project's scene: its actors and what its room shows. */
function sceneProject(
  board: BoardState,
  pulses: Pulses,
  project: Project,
  group: Group,
  now: number,
): SceneProject {
  const tone = projectTone(group.sessions, group.terminals);
  const live = podSessions(group.sessions);
  const main = live.find((s) => s.todos.length > 0) ?? live[0] ?? null;
  const ports = new Set<number>();
  for (const binding of Object.values(board.ports))
    if (binding.projectId === project.id) ports.add(binding.port);
  const pulse = pulses[activityKey.project(project.id)];
  const crashed = group.terminals.some((t) => t.state === 'open' && crashedTerminal(board, t));
  const lastActivity = Math.max(pulse?.lastAt ?? 0, project.lastActivityAt ?? 0) || null;
  const git = project.git;
  return {
    id: project.id,
    name: project.name,
    accent: project.accent,
    tone,
    actors: projectActors(board, pulses, project, group, now),
    branch: git ? (git.branch ?? (git.head ? git.head.slice(0, 7) : null)) : null,
    dirty: git?.dirty ?? 0,
    ports: [...ports].sort((a, b) => a - b),
    todos: (main?.todos ?? []).map((t) => ({
      text: t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content,
      done: t.status === 'completed',
    })),
    summary: lastLine(main?.lastAssistantText ?? null),
    commits: (git?.commits ?? []).map((c) => ({ hash: c.hash, at: c.at, subject: c.subject })),
    activity: levelAt(pulse, now),
    dim: isDimmed(tone, crashed, lastActivity, now),
  };
}

/**
 * The scene model for the board at `now`. Projects come in the overview's order (waiting, then
 * errors, then by name); actors inside a project attention first.
 */
export function buildSceneModel(board: BoardState, pulses: Pulses, now: number): SceneModel {
  const groups = groupByProject(board);
  const projects = new Map<string, SceneProject>();
  for (const project of Object.values(board.projects)) {
    projects.set(
      project.id,
      sceneProject(board, pulses, project, groups.get(project.id) ?? EMPTY, now),
    );
  }
  const order = orderPods(
    [...projects.values()].map((p) => ({ id: p.id, name: p.name, rank: attentionRank(p.tone) })),
  );
  const ordered = order.flatMap((id) => projects.get(id) ?? []);
  const actors = new Map<string, SceneActor>();
  for (const project of ordered) for (const actor of project.actors) actors.set(actor.id, actor);
  return { projects: ordered, actors };
}

/** Deep equality for the scene's plain data (objects, arrays, primitives). */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameData(item, b[i]));
  }
  if (Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return keys.every((key) => key in y && sameData(x[key], y[key]));
}

/**
 * `next` with every project that didn't change since `prev` kept as `prev`'s object, so a layout
 * can skip re-rendering it: a log firehose rebuilds the model many times a second, but only its
 * own project's scene changes (and often not even that). Returns `prev` when nothing changed.
 */
export function shareScene(prev: SceneModel | null, next: SceneModel): SceneModel {
  if (!prev) return next;
  const before = new Map(prev.projects.map((p) => [p.id, p]));
  let changed = prev.projects.length !== next.projects.length;
  const projects = next.projects.map((project, i) => {
    const old = before.get(project.id);
    if (old && sameData(old, project)) {
      if (prev.projects[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return project;
  });
  if (!changed) return prev;
  const actors = new Map<string, SceneActor>();
  for (const project of projects) for (const actor of project.actors) actors.set(actor.id, actor);
  return { projects, actors };
}

/** One project's scene (what an open inspector needs), or null when it's gone. */
export function buildSceneProject(
  board: BoardState,
  pulses: Pulses,
  projectId: string,
  now: number,
): SceneProject | null {
  const project = board.projects[projectId];
  if (!project) return null;
  const group: Group = {
    sessions: Object.values(board.sessions).filter((s) => s.projectId === projectId),
    terminals: Object.values(board.terminals).filter((t) => t.projectId === projectId),
  };
  return sceneProject(board, pulses, project, group, now);
}

/** `buildSceneModel` as a store selector. Pair it with a clock: it changes on every tick. */
export const selectSceneModel =
  (now: number) =>
  (s: Pick<BoardStoreState, 'board' | 'pulses'>): SceneModel =>
    buildSceneModel(s.board, s.pulses, now);

/** What a crew-state actor is doing, in words (the inspector's state line). */
export function actorStateLabel(actor: Pick<SceneActor, 'state' | 'kind'>): string {
  switch (actor.state) {
    case 'serving':
      return 'Serving';
    case 'exited':
      return 'Closed';
    case 'running':
      return actor.kind === 'claude' ? mascotLabel('running', null, 0) : 'Running';
    default:
      return mascotLabel(actor.state, null, 0);
  }
}
