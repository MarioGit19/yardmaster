import type { BoardState, ClaudeSession, SeenResponse, Terminal } from '@yardmaster/protocol';
import { useMemo } from 'react';
import { useNow } from '../anim/clock.js';
import { activityKey, selectCrashedCount, useBoard } from '../data/index.js';
import type { BoardStoreState } from '../data/store.js';
import { createPreference } from '../prefs.js';
import { useSeenItems } from '../seen.js';
import { projectStatusTone, statusContext } from '../statusTokens.js';
import { DIM_AFTER_MS, isDimmed } from './activity.js';

export const DENSITIES = ['comfortable', 'compact', 'list'] as const;
export type Density = (typeof DENSITIES)[number];

export const DENSITY_NAME: Record<Density, string> = {
  comfortable: 'Comfortable',
  compact: 'Compact',
  list: 'List',
};

/** How much a project shows on the overview and the phone's list. Kept per device. */
export const densityPreference = createPreference<Density>(
  'yardmaster.density',
  DENSITIES,
  'comfortable',
);

export type PodForm = 'card' | 'row';

/** A quiet project folds to one line; List folds every project. */
export const podForm = (density: Density, quiet: boolean): PodForm =>
  density === 'list' || quiet ? 'row' : 'card';

/** How often the split re-checks when nothing else changes. */
const QUIET_TICK_MS = 15_000;

function groupByProject<T extends { projectId: string | null }>(items: Record<string, T>) {
  const groups = new Map<string | null, T[]>();
  for (const item of Object.values(items)) {
    const group = groups.get(item.projectId);
    if (group) group.push(item);
    else groups.set(item.projectId, [item]);
  }
  return groups;
}

/**
 * Which of `ids` are quiet: the same test that dims a pod, so "quiet" means one thing in every
 * layout. Recent activity settles it first, so a busy board skips the status work.
 */
export function quietProjects(
  s: Pick<BoardStoreState, 'pulses'> & { board: BoardState },
  ids: readonly string[],
  seen: SeenResponse,
  now: number,
): string[] {
  const ctx = statusContext(s, seen, now);
  let sessions: Map<string | null, ClaudeSession[]> | undefined;
  let terminals: Map<string | null, Terminal[]> | undefined;
  return ids.filter((id) => {
    const pulse = s.pulses[activityKey.project(id)]?.lastAt ?? 0;
    const last = Math.max(pulse, s.board.projects[id]?.lastActivityAt ?? 0) || null;
    if (last !== null && now - last < DIM_AFTER_MS) return false;
    sessions ??= groupByProject(s.board.sessions);
    terminals ??= groupByProject(s.board.terminals);
    const tone = projectStatusTone(sessions.get(id) ?? [], terminals.get(id) ?? [], ctx);
    const crashed = selectCrashedCount(id)(s as BoardStoreState) > 0;
    return isDimmed(tone, crashed, last, now);
  });
}

const NONE: ReadonlySet<string> = new Set();

/** `quietProjects` as a set that only changes when a project crosses over. */
export function useQuietProjects(ids: readonly string[]): ReadonlySet<string> {
  const seen = useSeenItems();
  const now = useNow(QUIET_TICK_MS);
  const key = useBoard((s) => quietProjects(s, ids, seen, now).join('\n'));
  return useMemo(() => (key === '' ? NONE : new Set(key.split('\n'))), [key]);
}
