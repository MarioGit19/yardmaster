import type {
  Approval,
  ClaudeSession,
  EditorWindow,
  Execution,
  PortBinding,
  Project,
  Terminal,
} from '@c-board/protocol';
import type { BoardStoreState } from './store.js';

// Plain selectors over the store. Single-entity ones return the stored object, so they
// keep their identity until a patch touches that entity. List selectors build new
// arrays: pair them with `useShallow` (see `useBoardList`).

type S = BoardStoreState;

export const selectConnection = (s: S) => s.connection;
export const selectHydrated = (s: S) => s.hydrated;

export const selectProject = (id: string) => (s: S) => s.board.projects[id] as Project | undefined;
export const selectWindow = (id: string) => (s: S) =>
  s.board.windows[id] as EditorWindow | undefined;
export const selectTerminal = (id: string) => (s: S) =>
  s.board.terminals[id] as Terminal | undefined;
export const selectExecution = (id: string) => (s: S) =>
  s.board.executions[id] as Execution | undefined;
export const selectSession = (id: string) => (s: S) =>
  s.board.sessions[id] as ClaudeSession | undefined;
export const selectApproval = (id: string) => (s: S) =>
  s.board.approvals[id] as Approval | undefined;

const byName = (a: Project, b: Project) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const newestFirst = <T extends { startedAt: number; id: string }>(a: T, b: T) =>
  b.startedAt - a.startedAt || a.id.localeCompare(b.id);

export const selectProjects = (s: S): Project[] => Object.values(s.board.projects).sort(byName);
/** The project count alone: projects change on every bit of activity, the count rarely. */
export const selectProjectCount = (s: S) => Object.keys(s.board.projects).length;
export const selectWindowCount = (s: S) => Object.keys(s.board.windows).length;
/** Connected editor windows, oldest connection first. */
export const selectWindows = (s: S): EditorWindow[] =>
  Object.values(s.board.windows).sort((a, b) => a.connectedAt - b.connectedAt);

export const selectTerminalsByProject =
  (projectId: string | null) =>
  (s: S): Terminal[] =>
    Object.values(s.board.terminals).filter((t) => t.projectId === projectId);

export const selectSessionsByProject =
  (projectId: string | null) =>
  (s: S): ClaudeSession[] =>
    Object.values(s.board.sessions).filter((session) => session.projectId === projectId);

export const selectExecutionsByTerminal =
  (terminalId: string) =>
  (s: S): Execution[] =>
    Object.values(s.board.executions)
      .filter((e) => e.terminalId === terminalId)
      .sort(newestFirst);

export const selectPortsByProject =
  (projectId: string | null) =>
  (s: S): PortBinding[] =>
    Object.values(s.board.ports).filter((p) => p.projectId === projectId);

export const selectPendingApprovals = (s: S): Approval[] =>
  Object.values(s.board.approvals)
    .filter((a) => a.state === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

export const selectPortsByTerminal =
  (terminalId: string) =>
  (s: S): PortBinding[] =>
    Object.values(s.board.ports)
      .filter((p) => p.terminalId === terminalId)
      .sort((a, b) => a.port - b.port || a.id.localeCompare(b.id));

/** A failed exit that counts as a crash: Ctrl+C (SIGINT, 130) is the user stopping it. */
export const isCrashExit = (code: number | null | undefined): code is number =>
  code != null && code !== 0 && code !== 130;

/**
 * How many of the project's open terminals crashed: their newest command failed and nothing has
 * run since (DESIGN.md §4.10, "broke").
 */
export const selectCrashedCount =
  (projectId: string | null) =>
  (s: S): number => {
    let count = 0;
    for (const terminal of Object.values(s.board.terminals)) {
      if (terminal.projectId !== projectId || terminal.state !== 'open') continue;
      for (let i = terminal.executionIds.length - 1; i >= 0; i--) {
        const execution = s.board.executions[terminal.executionIds[i] ?? ''];
        if (!execution) continue;
        if (execution.endedAt !== null && isCrashExit(execution.exitCode)) count++;
        break;
      }
    }
    return count;
  };
