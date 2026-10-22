import type { ClaudeSession } from '@c-board/protocol';
import { useEffect, useRef } from 'react';
import { type CrewTerminal, DONE_MS, type MascotState, mascotStateFor } from '../crew/model.js';

/** States that "done" may stand in for while it plays. */
const RESTING = new Set<MascotState>(['idle', 'sleeping', 'watching']);

/**
 * `mascotStateFor` with memory: finishing a turn plays "done" once, and it holds for
 * `DONE_MS` even if the pod re-renders meanwhile.
 */
export function useMascotState(
  session: ClaudeSession | null,
  terminals: readonly CrewTerminal[],
  now: number,
): MascotState {
  const previous = useRef<MascotState | null>(null);
  const doneAt = useRef(0);
  let state = mascotStateFor(session, terminals, { now, previous: previous.current });
  if (state === 'done' && previous.current !== 'done') doneAt.current = Date.now();
  else if (
    previous.current === 'done' &&
    RESTING.has(state) &&
    Date.now() - doneAt.current < DONE_MS
  ) {
    state = 'done';
  }
  useEffect(() => {
    previous.current = state;
  });
  return state;
}
