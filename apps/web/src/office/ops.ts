import { DONE_MS, ERROR_X_EYES_MS } from '../crew/model.js';
import type { OpsState } from '../layouts/scene.js';

/** The ops crew's states, DESIGN.md §10.3. `sleeping` is idle after 5 min, with a "z". */
export const OPS_STATES = [
  'idle',
  'sleeping',
  'running',
  'serving',
  'done',
  'error',
  'waiting',
] as const;
export type OpsMascotState = (typeof OPS_STATES)[number];

export { DONE_MS as OPS_DONE_MS, ERROR_X_EYES_MS as OPS_X_EYES_MS };

/**
 * A terminal's ops crew state. A waiting linked Claude prompt wins over everything; a closed
 * terminal has nobody working in it, so its crew member sleeps.
 */
export function opsMascotState(state: OpsState, { waiting = false } = {}): OpsMascotState {
  if (waiting) return 'waiting';
  return state === 'exited' ? 'sleeping' : state;
}

/** The status color on the visor: the terminal's, by the same rules as everywhere (§10.1). */
export const OPS_COLOR: Record<OpsMascotState, string> = {
  idle: 'var(--ops-idle)',
  sleeping: 'var(--ops-idle)',
  running: 'var(--st-tool)',
  serving: 'var(--st-tool)',
  done: 'var(--st-ok)',
  error: 'var(--st-err)',
  waiting: 'var(--st-wait)',
};

const LABEL: Record<OpsMascotState, string> = {
  idle: 'Idle',
  sleeping: 'Asleep',
  running: 'Running a command',
  serving: 'Serving',
  done: 'Done',
  error: 'Failed',
  waiting: 'Waiting for you',
};

export function opsLabel(state: OpsMascotState, exit: number | null = null): string {
  if (state === 'error' && exit !== null) return `${LABEL.error} with exit ${exit}`;
  return LABEL[state];
}

/** Where a terminal's crew member works in its room (§10.3). */
export type OpsStation = 'couch' | 'bench' | 'rack';

/**
 * The station for a state, given where the crew member stands now. Done, error and waiting
 * play where the command ran; done then walks to the couch once it settles into idle.
 */
export function opsStation(state: OpsMascotState, from: OpsStation = 'couch'): OpsStation {
  switch (state) {
    case 'running':
      return 'bench';
    case 'serving':
      return 'rack';
    case 'idle':
    case 'sleeping':
      return 'couch';
    default:
      return from;
  }
}
