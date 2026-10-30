import type { ClaudeSession } from '@yardmaster/protocol';
import type { ReactNode } from 'react';
import { useNow } from '../anim/clock.js';
import { runningHelpers } from '../background/model.js';
import { CrewMascot } from '../crew/CrewMascot.js';
import { useCrewTerminals } from '../crew/useCrewTerminals.js';
import { selectTerminalsByProject, useBoardList } from '../data/index.js';
import { useMascotState } from '../pod/useMascotState.js';

/** Sleeping crews only need to notice five quiet minutes. */
const IDLE_CLOCK_MS = 15_000;

/**
 * The crew member a quiet chat shows (DESIGN.md §4.11): it watches the session from here on, so a
 * finished turn still plays its done sparkle when the mascot appears at the end of the transcript.
 */
export function useRestingCrew(
  session: ClaudeSession | null,
  projectId: string,
  size: number,
): ReactNode {
  const raw = useBoardList(selectTerminalsByProject(projectId));
  const crew = useCrewTerminals(raw);
  const now = useNow(IDLE_CLOCK_MS);
  const state = useMascotState(session, crew.terminals, now);
  return (
    <span aria-hidden data-focus-crew className="flex w-fit shrink-0">
      <CrewMascot
        state={state}
        size={size}
        color="var(--accent)"
        tool={session?.status.kind === 'tool' ? session.status.tool : null}
        subagents={session?.subagents.filter((a) => a.status === 'running').length ?? 0}
        helpers={session ? runningHelpers(session) : undefined}
        activity={crew.activity}
      />
    </span>
  );
}
