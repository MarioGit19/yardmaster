import type { StatusWordInput } from '../types.js';

/**
 * A status in the departures board's words (DESIGN.md §10.5), for the Transit workspace's session
 * list and phone hub (§10.8). Only the words change: the tone, its color and its mark stay.
 */
export function boardWord(input: StatusWordInput): string {
  if (input.kind === 'terminal') {
    if (input.running) return 'Departing';
    if (input.exit !== null) return input.exit === 0 ? 'Arrived' : `Cancelled · exit ${input.exit}`;
    return input.closed ? 'Out of service' : 'At platform';
  }
  const { status } = input;
  switch (status.kind) {
    case 'waiting_permission':
    case 'waiting_input':
      return 'Due · needs you';
    case 'error':
      return 'Cancelled';
    case 'working':
    case 'compacting':
      return 'Departing';
    case 'tool':
      return `Departing · ${status.tool}`;
    case 'unknown':
      return status.alive ? 'In service' : 'At platform';
    case 'idle':
      return 'At platform';
    case 'interrupted':
      return 'Held · interrupted';
    case 'ended':
      return 'Out of service';
  }
}
