import {
  type BoardState,
  type ClaudeSession,
  isSafeCommandLine,
  type Project,
  sessionDisplayName,
  sessionSubtitle,
  type UiAction,
  visibleCommandLine,
} from '@yardmaster/protocol';
import { isWaiting, sessionInterruptAction } from '../attention/attention.js';
import { terminalSession } from '../data/selectors.js';
import type { Phosphor } from '../fx/FaultyTerminal.js';
import { laneExecution, terminalDisplay } from '../lanes/lane.js';
import { LAYOUT_NAME, LAYOUTS, type LayoutId } from '../layouts/registry.js';
import type { MotionSetting } from '../motion.js';
import { countOf } from '../plural.js';
import { DENSITIES, DENSITY_NAME, type Density } from '../pod/density.js';
import { PHOSPHOR_LABEL, PHOSPHORS } from '../retro/phosphor.js';
import { projectHref, routes, sessionHref } from '../routes.js';
import { sessionStatusView, type Tone } from '../status.js';
import type { ThemeSetting } from '../theme/theme.js';
import { type FuzzyMatch, fuzzyMatch } from './fuzzy.js';

export const PALETTE_GROUPS = ['Projects', 'Sessions', 'Terminals', 'Actions'] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

/** What selecting a command does. The palette component carries it out. */
export type PaletteRun =
  | { kind: 'navigate'; href: string; terminal?: { projectId: string; terminalId: string } }
  | { kind: 'action'; action: UiAction; done: string }
  | { kind: 'approveAll'; approvalIds: string[] }
  | { kind: 'newSession'; projectId: string; projectName: string }
  | { kind: 'newTerminal'; projectId: string }
  | { kind: 'motion'; next: MotionSetting }
  | { kind: 'theme'; next: ThemeSetting }
  | { kind: 'layout'; next: LayoutId }
  | { kind: 'density'; next: Density }
  | { kind: 'phosphor'; next: Phosphor }
  | { kind: 'attention' }
  | { kind: 'openProject' }
  | { kind: 'closeProject'; projectId: string; forget: boolean }
  | { kind: 'rail' }
  | { kind: 'pulse' };

export type PaletteIcon =
  | 'project'
  | 'session'
  | 'terminal'
  | 'new'
  | 'interrupt'
  | 'approve'
  | 'rerun'
  | 'editor'
  | 'motion'
  | 'theme'
  | 'layout'
  | 'density'
  | 'phosphor'
  | 'settings'
  | 'attention'
  | 'rail'
  | 'pulse'
  | 'overview'
  | 'open'
  | 'close'
  | 'forget';

export interface PaletteCommand {
  /** Stable and unique: the cmdk item value. */
  id: string;
  group: PaletteGroup;
  label: string;
  /** Secondary text after the label, matched but not highlighted. */
  hint?: string;
  /** Mono hint (a command line). */
  hintMono?: boolean;
  icon: PaletteIcon;
  /** Project identity for the icon (accent ring). */
  project?: Pick<Project, 'name' | 'accent'>;
  tone?: Tone;
  /** Keys of the global shortcut that does the same, for the hint. */
  shortcut?: readonly string[];
  /** Listed only once the user types, to keep the opening list short. */
  searchOnly?: boolean;
  run: PaletteRun;
}

export interface PaletteContext {
  /** The project in the focus view, which scopes the project actions. */
  projectId: string | null;
  motion: MotionSetting;
  nextMotion: MotionSetting;
  theme: ThemeSetting;
  nextTheme: ThemeSetting;
  layout: LayoutId;
  density: Density;
  /** Retro's phosphor color (DESIGN.md §10.6). */
  phosphor: Phosphor;
  /** The rail can be toggled (it is pinned to icons on narrow screens). */
  railToggle: boolean;
  /** Shortcut hints use ⌘ rather than Ctrl. */
  mac?: boolean;
}

const MOTION_NAME: Record<MotionSetting, string> = {
  system: 'System',
  full: 'Full',
  reduced: 'Reduced',
  off: 'Off',
};
const THEME_NAME: Record<ThemeSetting, string> = { dark: 'Dark', light: 'Light', system: 'System' };

const byName = (a: Project, b: Project) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

const isBusy = (session: ClaudeSession) =>
  session.status.kind === 'working' ||
  session.status.kind === 'tool' ||
  session.status.kind === 'compacting';

/** The editor app showing the project, for "Open in …". Never a logo, just its name. */
export function editorName(board: Pick<BoardState, 'windows'>, projectId: string): string {
  const window = Object.values(board.windows).find((w) => w.projectIds.includes(projectId));
  return window?.appName || 'Cursor';
}

/** The newest re-runnable command in `projectId` (or anywhere when null). */
function lastCommand(board: BoardState, projectId: string | null) {
  let best: { execId: string; commandLine: string; projectId: string; startedAt: number } | null =
    null;
  for (const execution of Object.values(board.executions)) {
    const terminal = board.terminals[execution.terminalId];
    if (!terminal?.projectId || terminal.state !== 'open') continue;
    if (projectId !== null && terminal.projectId !== projectId) continue;
    if (execution.interactive || execution.commandLine.trim() === '') continue;
    if (!isSafeCommandLine(execution.commandLine)) continue;
    if (best && best.startedAt >= execution.startedAt) continue;
    best = {
      execId: execution.id,
      commandLine: visibleCommandLine(execution.commandLine.trim()),
      projectId: terminal.projectId,
      startedAt: execution.startedAt,
    };
  }
  return best;
}

/** Every command for the current board, in display order within each group. */
export function buildCommands(board: BoardState, context: PaletteContext): PaletteCommand[] {
  const projects = Object.values(board.projects).sort(byName);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const commands: PaletteCommand[] = [];

  for (const project of projects) {
    commands.push({
      id: `project:${project.id}`,
      group: 'Projects',
      label: project.name,
      ...(project.git?.branch ? { hint: project.git.branch, hintMono: true } : {}),
      icon: 'project',
      project,
      run: { kind: 'navigate', href: projectHref(project.id) },
    });
  }

  const sessions = Object.values(board.sessions)
    .filter((s) => s.projectId !== null && projectById.has(s.projectId))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  for (const session of sessions) {
    const project = projectById.get(session.projectId ?? '');
    if (!project) continue;
    const status = sessionStatusView(session.status);
    commands.push({
      id: `session:${session.id}`,
      group: 'Sessions',
      label: sessionDisplayName(session),
      // The automatic name or summary is context, so "Claude" sessions stay findable by it.
      hint: [project.name, status.label, sessionSubtitle(session)].filter(Boolean).join(' · '),
      icon: 'session',
      tone: status.tone,
      searchOnly: session.status.kind === 'ended',
      run: { kind: 'navigate', href: sessionHref(project.id, session.id) },
    });
  }

  const terminals = Object.values(board.terminals)
    .filter((t) => t.state === 'open' && t.projectId !== null && projectById.has(t.projectId))
    .sort(
      (a, b) =>
        (projectById.get(a.projectId ?? '')?.name ?? '').localeCompare(
          projectById.get(b.projectId ?? '')?.name ?? '',
        ) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
  for (const terminal of terminals) {
    const project = projectById.get(terminal.projectId ?? '');
    if (!project) continue;
    // A Claude terminal goes by its session; it opens in the stack, which shows its chat.
    const session = terminalSession(board, terminal.id);
    const { name } = terminalDisplay(terminal, laneExecution(board, terminal), session);
    if (session) {
      const status = sessionStatusView(session.status);
      commands.push({
        id: `terminal:${terminal.id}`,
        group: 'Terminals',
        label: name,
        hint: `${project.name} · Claude terminal`,
        icon: 'session',
        tone: status.tone,
        run: {
          kind: 'navigate',
          href: projectHref(project.id),
          terminal: { projectId: project.id, terminalId: terminal.id },
        },
      });
      continue;
    }
    commands.push({
      id: `terminal:${terminal.id}`,
      group: 'Terminals',
      label: name,
      hint: project.name,
      icon: 'terminal',
      run: {
        kind: 'navigate',
        href: projectHref(project.id),
        terminal: { projectId: project.id, terminalId: terminal.id },
      },
    });
  }

  commands.push(...projectActions(board, context, projects));
  commands.push(...boardActions(context, waitingCount(board)));
  return commands;
}

/** Actions on a project: the focused one, or (search only) every project from the overview. */
function projectActions(
  board: BoardState,
  context: PaletteContext,
  projects: readonly Project[],
): PaletteCommand[] {
  const focused = projects.find((p) => p.id === context.projectId) ?? null;
  const scope = focused ? [focused] : projects;
  const searchOnly = focused === null;
  const commands: PaletteCommand[] = [];

  for (const project of scope) {
    commands.push({
      id: `new-session:${project.id}`,
      group: 'Actions',
      label: `New session in ${project.name}`,
      icon: 'new',
      searchOnly,
      run: { kind: 'newSession', projectId: project.id, projectName: project.name },
    });
    commands.push({
      id: `new-terminal:${project.id}`,
      group: 'Actions',
      label: `New terminal in ${project.name}…`,
      icon: 'terminal',
      searchOnly,
      run: { kind: 'newTerminal', projectId: project.id },
    });
  }

  const sessions = Object.values(board.sessions).sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
  for (const session of sessions) {
    if (!isBusy(session)) continue;
    const project = scope.find((p) => p.id === session.projectId);
    if (!project) continue;
    const action = sessionInterruptAction(session);
    if (!action) continue;
    commands.push({
      id: `interrupt:${session.id}`,
      group: 'Actions',
      label: `Interrupt ${sessionDisplayName(session)}`,
      hint: project.name,
      icon: 'interrupt',
      run: { kind: 'action', action, done: 'Interrupted' },
    });
  }

  for (const project of scope) {
    const waiting = new Set(
      Object.values(board.sessions)
        .filter((s) => s.projectId === project.id && isWaiting(s))
        .map((s) => s.id),
    );
    const approvalIds = Object.values(board.approvals)
      .filter((a) => a.state === 'pending' && waiting.has(a.sessionId))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((a) => a.id);
    if (approvalIds.length === 0) continue;
    commands.push({
      id: `approve-all:${project.id}`,
      group: 'Actions',
      label: `Approve all waiting in ${project.name}`,
      hint: countOf(approvalIds.length, 'request'),
      icon: 'approve',
      tone: 'wait',
      run: { kind: 'approveAll', approvalIds },
    });
  }

  const last = lastCommand(board, focused?.id ?? null);
  if (last) {
    const project = projects.find((p) => p.id === last.projectId);
    commands.push({
      id: 'rerun-last',
      group: 'Actions',
      label: focused
        ? 'Re-run last command'
        : `Re-run last command in ${project?.name ?? 'project'}`,
      hint: last.commandLine,
      hintMono: true,
      icon: 'rerun',
      run: {
        kind: 'action',
        action: { kind: 'terminal.rerun', execId: last.execId },
        done: `Re-running ${last.commandLine}`,
      },
    });
  }

  for (const project of scope) {
    const editor = editorName(board, project.id);
    commands.push({
      id: `open-editor:${project.id}`,
      group: 'Actions',
      label: `Open ${project.name} in ${editor}`,
      icon: 'editor',
      searchOnly,
      run: {
        kind: 'action',
        action: { kind: 'project.openInEditor', projectId: project.id },
        done: `Opened in ${editor}`,
      },
    });
  }

  for (const project of scope) {
    // A closed project is still findable (opening it brings it back), but not closable again.
    if (project.closedAt == null) {
      commands.push({
        id: `close:${project.id}`,
        group: 'Actions',
        label: `Close ${project.name}`,
        hint: 'stops what the board runs there',
        icon: 'close',
        searchOnly,
        run: { kind: 'closeProject', projectId: project.id, forget: false },
      });
    }
    commands.push({
      id: `forget:${project.id}`,
      group: 'Actions',
      label: `Forget ${project.name}`,
      hint: 'and drop it from recents',
      icon: 'forget',
      searchOnly: true,
      run: { kind: 'closeProject', projectId: project.id, forget: true },
    });
  }
  return commands;
}

function waitingCount(board: BoardState): number {
  return Object.values(board.sessions).filter(isWaiting).length;
}

function boardActions(context: PaletteContext, waiting: number): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  if (context.projectId !== null) {
    commands.push({
      id: 'overview',
      group: 'Actions',
      label: 'Back to the overview',
      icon: 'overview',
      shortcut: ['Esc'],
      run: { kind: 'navigate', href: routes.overview },
    });
  }
  commands.push(
    {
      id: 'open-project',
      group: 'Actions',
      label: 'Open project…',
      hint: 'from your project folders',
      icon: 'open',
      shortcut: context.mac ? ['⌘', 'O'] : ['Ctrl', 'O'],
      run: { kind: 'openProject' },
    },
    {
      id: 'attention',
      group: 'Actions',
      label: 'Open the Attention Center',
      ...(waiting > 0 ? { hint: `${waiting} waiting`, tone: 'wait' as const } : {}),
      icon: 'attention',
      run: { kind: 'attention' },
    },
    {
      id: 'motion',
      group: 'Actions',
      label: `Switch motion to ${MOTION_NAME[context.nextMotion]}`,
      hint: `Now ${MOTION_NAME[context.motion]}`,
      icon: 'motion',
      run: { kind: 'motion', next: context.nextMotion },
    },
    {
      id: 'theme',
      group: 'Actions',
      label: `Switch theme to ${THEME_NAME[context.nextTheme]}`,
      hint: `Now ${THEME_NAME[context.theme]}`,
      icon: 'theme',
      run: { kind: 'theme', next: context.nextTheme },
    },
    {
      id: 'settings',
      group: 'Actions',
      label: 'Open settings',
      icon: 'settings',
      run: { kind: 'navigate', href: routes.settings },
    },
    {
      id: 'setup',
      group: 'Actions',
      label: 'Open the setup guide',
      hint: 'hooks and extension',
      icon: 'settings',
      searchOnly: true,
      run: { kind: 'navigate', href: routes.welcome },
    },
  );
  LAYOUTS.forEach((layout, i) => {
    const current = layout === context.layout;
    commands.push({
      id: `layout:${layout}`,
      group: 'Actions',
      label: `Layout: ${LAYOUT_NAME[layout]}`,
      ...(current ? { hint: 'Current' } : {}),
      icon: 'layout',
      shortcut: ['⌥', String(i + 1)],
      // The current one is only listed when searched for.
      searchOnly: current,
      run: { kind: 'layout', next: layout },
    });
  });
  for (const density of DENSITIES) {
    commands.push({
      id: `density:${density}`,
      group: 'Actions',
      label: `Density: ${DENSITY_NAME[density]}`,
      ...(density === context.density ? { hint: 'Current' } : {}),
      icon: 'density',
      searchOnly: true,
      run: { kind: 'density', next: density },
    });
  }
  // Retro's colors open the list only in Retro; elsewhere a search finds them.
  for (const phosphor of PHOSPHORS) {
    const current = phosphor === context.phosphor;
    commands.push({
      id: `phosphor:${phosphor}`,
      group: 'Actions',
      label: `Retro color: ${PHOSPHOR_LABEL[phosphor]}`,
      ...(current ? { hint: 'Current' } : {}),
      icon: 'phosphor',
      searchOnly: current || context.layout !== 'retro',
      run: { kind: 'phosphor', next: phosphor },
    });
  }
  commands.push({
    id: 'pulse',
    group: 'Actions',
    label: 'Toggle the Pulse timeline',
    icon: 'pulse',
    run: { kind: 'pulse' },
  });
  if (context.railToggle) {
    commands.push({
      id: 'rail',
      group: 'Actions',
      label: 'Toggle the project rail',
      icon: 'rail',
      shortcut: ['['],
      run: { kind: 'rail' },
    });
  }
  return commands;
}

export interface PaletteResult {
  command: PaletteCommand;
  /** Matched characters of the label. */
  indices: number[];
}

export interface PaletteSection {
  group: PaletteGroup;
  results: PaletteResult[];
}

/** Per group, so one long group never buries the others. */
export const GROUP_LIMIT = { browse: 6, search: 8 } as const;

/**
 * Filters and ranks commands for `query`. Empty: everything not search-only, in order.
 * Otherwise label matches (highlighted) beat hint-only matches, and groups are ordered by their
 * best result. The total stays well under the virtualization threshold.
 */
export function searchCommands(
  commands: readonly PaletteCommand[],
  query: string,
): PaletteSection[] {
  const searching = query.trim() !== '';
  const limit = searching ? GROUP_LIMIT.search : GROUP_LIMIT.browse;
  const scored = new Map<PaletteGroup, { result: PaletteResult; score: number; order: number }[]>();

  commands.forEach((command, order) => {
    let match: FuzzyMatch | null;
    let indices: number[] = [];
    if (!searching) {
      if (command.searchOnly) return;
      match = { score: 0, indices: [] };
    } else {
      const label = fuzzyMatch(query, command.label);
      if (label) {
        match = label;
        indices = label.indices;
      } else {
        // Hint matches rank below label ones: the hint is context, not the name.
        const full = fuzzyMatch(query, `${command.label} ${command.hint ?? ''}`);
        match = full ? { score: full.score / 2, indices: [] } : null;
        if (full) {
          indices = full.indices.filter((i) => i < command.label.length);
        }
      }
      if (!match) return;
    }
    const list = scored.get(command.group) ?? [];
    list.push({ result: { command, indices }, score: match.score, order });
    scored.set(command.group, list);
  });

  const sections = PALETTE_GROUPS.flatMap((group) => {
    const list = scored.get(group);
    if (!list?.length) return [];
    if (searching) list.sort((a, b) => b.score - a.score || a.order - b.order);
    const top = list.slice(0, limit);
    return [{ group, results: top.map((e) => e.result), best: top[0]?.score ?? 0 }];
  });
  if (searching) sections.sort((a, b) => b.best - a.best);
  return sections.map(({ group, results }) => ({ group, results }));
}
