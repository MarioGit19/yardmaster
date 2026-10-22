import type { Terminal } from '@c-board/protocol';
import { activityKey, useBusyFlags, useLatestActivity, useMaxActivityStep } from '../data/index.js';
import type { CrewTerminal } from './model.js';

/**
 * A project's terminals as the crew sees them (§4.11): which stream, when they last wrote, and
 * how busy the busiest is (0..1), which drives the watching monitor's flicker.
 */
export function useCrewTerminals(raw: readonly Terminal[]): {
  terminals: CrewTerminal[];
  activity: number;
} {
  const keys = raw.map((t) => activityKey.terminal(t.id));
  const busy = useBusyFlags(keys);
  const lastOutputAt = useLatestActivity(keys);
  const step = useMaxActivityStep(keys);
  const terminals = raw.map(
    (t, i): CrewTerminal => ({
      state: t.state,
      createdAt: t.createdAt,
      closedAt: t.closedAt,
      streaming: busy[i] === '1',
      lastOutputAt,
    }),
  );
  return { terminals, activity: step / 3 };
}
