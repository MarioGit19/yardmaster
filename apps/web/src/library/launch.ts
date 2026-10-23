import {
  type LibraryEntry,
  PermissionMode,
  type Project,
  projectIdFromPath,
  type UiAction,
} from '@c-board/protocol';
import { type FuzzyMatch, fuzzyMatch } from '../palette/fuzzy.js';
import type { KeyValueStorage } from '../prefs.js';

/** What the launch sheet starts in a project; remembered per folder. */
export interface LaunchChoice {
  editor: boolean;
  claude: boolean;
  terminal: boolean;
  /** A model alias from the composer's list; `''` leaves it to Claude Code's settings. */
  model: string;
  permissionMode: PermissionMode;
  command: string;
}

export const DEFAULT_CHOICE: LaunchChoice = {
  editor: true,
  claude: false,
  terminal: false,
  model: '',
  permissionMode: 'default',
  command: '',
};

/** The board project a library folder is (or will be, once added). */
export const entryProjectId = (entry: Pick<LibraryEntry, 'path' | 'projectId'>) =>
  entry.projectId ?? projectIdFromPath(entry.path);

export interface PickerRow {
  entry: LibraryEntry;
  /** Matched characters of the name. */
  indices: number[];
  /** The branch, for a repository the board has seen. */
  branch: string | null;
}

/**
 * The picker's list for `query`. Empty: every folder in the server's order (recents first, then by
 * name). Otherwise fuzzy matches on the name, best first; a match only in the path ranks below.
 */
export function pickerRows(
  entries: readonly LibraryEntry[],
  query: string,
  projects: Readonly<Record<string, Pick<Project, 'git'>>>,
): PickerRow[] {
  const branchOf = (entry: LibraryEntry) =>
    entry.git ? (projects[entryProjectId(entry)]?.git?.branch ?? null) : null;
  const q = query.trim();
  if (q === '') return entries.map((entry) => ({ entry, indices: [], branch: branchOf(entry) }));
  const scored: { row: PickerRow; score: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    const name = fuzzyMatch(q, entry.name);
    const path: FuzzyMatch | null = name ? null : fuzzyMatch(q, entry.path);
    const match = name ?? (path ? { score: path.score / 2, indices: [] } : null);
    if (!match) return;
    scored.push({
      row: { entry, indices: name?.indices ?? [], branch: branchOf(entry) },
      score: match.score,
      order,
    });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.row);
}

/** One step of a launch, in the order they are sent. */
export type LaunchStep =
  | { kind: 'editor'; action: Extract<UiAction, { kind: 'project.openInEditor' }> }
  | { kind: 'claude'; action: Extract<UiAction, { kind: 'session.create' }> }
  | { kind: 'terminal'; action: Extract<UiAction, { kind: 'terminal.create' }> };

/**
 * The actions a launch sends. The editor goes first, so a terminal can open in its window; Claude
 * needs a prompt. Empty when nothing would start.
 */
export function launchSteps(projectId: string, choice: LaunchChoice, prompt: string): LaunchStep[] {
  const steps: LaunchStep[] = [];
  if (choice.editor) {
    steps.push({ kind: 'editor', action: { kind: 'project.openInEditor', projectId } });
  }
  const text = prompt.trim();
  if (choice.claude && text !== '') {
    steps.push({
      kind: 'claude',
      action: {
        kind: 'session.create',
        projectId,
        prompt: text,
        ...(choice.model !== '' ? { model: choice.model } : {}),
        ...(choice.permissionMode !== 'default' ? { permissionMode: choice.permissionMode } : {}),
      },
    });
  }
  if (choice.terminal) {
    const command = choice.command.replace(/\s+/g, ' ').trim();
    steps.push({
      kind: 'terminal',
      action: { kind: 'terminal.create', projectId, ...(command !== '' ? { command } : {}) },
    });
  }
  return steps;
}

/** Why the launch button is off, or null when it can go. */
export function launchBlocker(choice: LaunchChoice, prompt: string): string | null {
  if (!choice.editor && !choice.claude && !choice.terminal) return 'Pick something to start';
  if (choice.claude && prompt.trim() === '') return 'Tell Claude what to do';
  return null;
}

/** "Cursor + pnpm dev + Claude": what the launch button will start. */
export function launchSummary(choice: LaunchChoice, editorName: string): string {
  const parts: string[] = [];
  if (choice.editor) parts.push(editorName);
  if (choice.terminal) parts.push(choice.command.trim() || 'terminal');
  if (choice.claude) parts.push('Claude');
  return parts.join(' + ');
}

/** A stored choice, checked field by field: storage is outside input. */
function parseChoice(value: unknown): LaunchChoice | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const mode = PermissionMode.safeParse(v.permissionMode);
  if (
    typeof v.editor !== 'boolean' ||
    typeof v.claude !== 'boolean' ||
    typeof v.terminal !== 'boolean' ||
    typeof v.model !== 'string' ||
    v.model.length > 128 ||
    typeof v.command !== 'string' ||
    v.command.length > 1_000 ||
    !mode.success
  ) {
    return null;
  }
  return {
    editor: v.editor,
    claude: v.claude,
    terminal: v.terminal,
    model: v.model,
    permissionMode: mode.data,
    command: v.command,
  };
}

export const LAUNCH_KEY = 'cboard.launch';
/** Folders whose last choice is kept; the least recently launched go first. */
export const MAX_REMEMBERED = 50;

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The last launch choice per folder path, in localStorage. Bad entries read as the default. */
export function createLaunchMemory(storage: KeyValueStorage | undefined = defaultStorage()) {
  const read = (): [string, unknown][] => {
    try {
      const raw: unknown = JSON.parse(storage?.getItem(LAUNCH_KEY) ?? '[]');
      return Array.isArray(raw)
        ? raw.filter(
            (e): e is [string, unknown] =>
              Array.isArray(e) && e.length === 2 && typeof e[0] === 'string',
          )
        : [];
    } catch {
      return [];
    }
  };
  return {
    get(path: string): LaunchChoice {
      const found = read().find(([p]) => p === path);
      return (found && parseChoice(found[1])) ?? DEFAULT_CHOICE;
    },
    set(path: string, choice: LaunchChoice) {
      const rest = read().filter(([p]) => p !== path);
      const next = [...rest, [path, choice]].slice(-MAX_REMEMBERED);
      try {
        storage?.setItem(LAUNCH_KEY, JSON.stringify(next));
      } catch {
        // Storage can be full or disabled; the sheet then starts from the default next time.
      }
    },
  };
}

export const launchMemory = createLaunchMemory();

/** How long a launch waits for an added project to reach the board. */
export const ADD_TIMEOUT_MS = 5_000;

export interface LaunchClient {
  action(
    action: UiAction,
  ): Promise<{ ok: true; sessionId?: string } | { ok: false; error: string }>;
}

export interface LaunchBoard {
  has(projectId: string): boolean;
  /** Calls back on every board change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export type LaunchOutcome =
  | {
      ok: true;
      projectId: string;
      /** The session Claude started, to open in the focus view. */
      sessionId: string | null;
      /** Steps the server refused, with its error codes. */
      failed: { kind: LaunchStep['kind']; error: string }[];
    }
  | { ok: false; error: string };

function waitFor(board: LaunchBoard, projectId: string, timeoutMs: number): Promise<boolean> {
  if (board.has(projectId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (found: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(found);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const unsubscribe = board.subscribe(() => {
      if (board.has(projectId)) done(true);
    });
  });
}

/**
 * Starts what the sheet asked for: puts a folder that isn't on the board on it (`project.add`),
 * waits until it shows up, then sends each step in order. A refused step doesn't stop the rest.
 */
export async function runLaunch(options: {
  client: LaunchClient;
  board: LaunchBoard;
  entry: Pick<LibraryEntry, 'path' | 'projectId'>;
  choice: LaunchChoice;
  prompt: string;
  timeoutMs?: number;
}): Promise<LaunchOutcome> {
  const { client, board, entry, choice, prompt } = options;
  const projectId = entryProjectId(entry);
  if (!board.has(projectId)) {
    const added = await client.action({ kind: 'project.add', path: entry.path });
    if (!added.ok) return added;
    if (!(await waitFor(board, projectId, options.timeoutMs ?? ADD_TIMEOUT_MS))) {
      return { ok: false, error: 'timeout' };
    }
  }
  let sessionId: string | null = null;
  const failed: { kind: LaunchStep['kind']; error: string }[] = [];
  for (const step of launchSteps(projectId, choice, prompt)) {
    const result = await client.action(step.action);
    if (!result.ok) failed.push({ kind: step.kind, error: result.error });
    else if (step.kind === 'claude') sessionId = result.sessionId ?? null;
  }
  return { ok: true, projectId, sessionId, failed };
}
