import type { ClaudeSession } from '@c-board/protocol';
import { runningHelpers } from '../background/model.js';
import { CrewMascot } from '../crew/CrewMascot.js';
import type { CrewTerminal } from '../crew/model.js';
import { useMascotState } from './useMascotState.js';

/** A session row's crew member (DESIGN.md §4.11): posture only, the orb as its antenna. */
export const ROW_CREW_PX = 24;

/** The project's terminals as the crew sees them, from `useCrewTerminals`. */
export interface CrewView {
  terminals: readonly CrewTerminal[];
  /** 0..1, the busiest terminal's output rate. */
  activity: number;
}

/** The crew member for one session, as the session lists show it (pod rows and the focus list). */
export function SessionCrew({
  session,
  accent,
  crew,
  now,
  countdown,
  size = ROW_CREW_PX,
}: {
  session: ClaudeSession | null;
  accent: string;
  crew: CrewView;
  now: number;
  countdown?: { startedAt: number; endsAt: number } | null;
  size?: number;
}) {
  const state = useMascotState(session, crew.terminals, now);
  return (
    <CrewMascot
      state={state}
      size={size}
      color={accent}
      tool={session?.status.kind === 'tool' ? session.status.tool : null}
      subagents={session?.subagents.filter((a) => a.status === 'running').length ?? 0}
      helpers={session ? runningHelpers(session) : undefined}
      countdown={countdown}
      activity={crew.activity}
    />
  );
}
