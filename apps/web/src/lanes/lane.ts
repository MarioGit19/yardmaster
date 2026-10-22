import type { Execution, Terminal } from '@c-board/protocol';
import type { BoardStoreState } from '../data/store.js';
import type { Tone } from '../status.js';

/** The execution fields a lane shows. No `outputBytes`, so streaming doesn't re-render lanes. */
export type LaneExecution = Pick<
  Execution,
  'id' | 'commandLine' | 'startedAt' | 'endedAt' | 'exitCode' | 'interactive'
>;

const NO_EXECUTION = {
  id: null,
  commandLine: null,
  startedAt: null,
  endedAt: null,
  exitCode: null,
  interactive: false,
} as const;

/**
 * The terminal's newest execution as a flat object of primitives; pair it with a shallow
 * compare so the lane only re-renders when one of these fields changes.
 */
export const selectLaneExecution =
  (terminal: Pick<Terminal, 'executionIds'>) =>
  (s: BoardStoreState): LaneExecution | typeof NO_EXECUTION => {
    for (let i = terminal.executionIds.length - 1; i >= 0; i--) {
      const execution = s.board.executions[terminal.executionIds[i] ?? ''];
      if (!execution) continue;
      const { id, commandLine, startedAt, endedAt, exitCode, interactive } = execution;
      return { id, commandLine, startedAt, endedAt, exitCode, interactive };
    }
    return NO_EXECUTION;
  };

export interface LaneView {
  /** The running or last command; null when the terminal never ran one we know of. */
  command: string | null;
  running: boolean;
  /** When the running command started. */
  startedAt: number | null;
  /** The last finished command's (or the closed terminal's) exit status. */
  exit: { key: string; code: number } | null;
  tone: Tone;
  label: string;
}

export function laneView(
  terminal: Pick<Terminal, 'id' | 'name' | 'state' | 'exitCode'>,
  execution: LaneExecution | typeof NO_EXECUTION,
): LaneView {
  const running = execution.id !== null && execution.endedAt === null && terminal.state === 'open';
  let exit: LaneView['exit'] = null;
  if (!running && execution.id !== null && execution.exitCode !== null) {
    exit = { key: execution.id, code: execution.exitCode };
  } else if (terminal.state === 'closed' && terminal.exitCode !== null) {
    exit = { key: `${terminal.id}:closed`, code: terminal.exitCode };
  }
  const tone: Tone = exit && exit.code !== 0 ? 'err' : running ? 'ok' : 'idle';
  const command = execution.commandLine?.trim() || null;
  const status = running
    ? 'running'
    : exit
      ? exit.code === 0
        ? 'exited 0'
        : `failed with exit code ${exit.code}`
      : 'idle';
  return {
    command,
    running,
    startedAt: running ? execution.startedAt : null,
    exit,
    tone,
    label: `${terminal.name}${command ? `: ${command}` : ''}, ${status}`,
  };
}

/** 9 s → "9s", 125 s → "2m", 3 h 5 m → "3h", 2 d → "2d". */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** How often an uptime label needs a refresh: seconds tick fast, the rest slowly. */
export function uptimePeriod(ms: number): number {
  return ms < 60_000 ? 1_000 : 15_000;
}
