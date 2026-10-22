import { useState } from 'react';
import {
  selectHydrated,
  selectProjects,
  selectWindowCount,
  useBoard,
  useBoardList,
} from '../data/index.js';
import { usePreference } from '../prefs.js';
import { useServerStatus } from '../settings/useServerStatus.js';
import { needsOnboarding, onboardingPreference } from './model.js';

/**
 * Whether the overview shows the setup guide: null while undecided. Once shown it stays until
 * finished or skipped, even as the first project arrives from the very events it waits for.
 */
export function useOnboarding(): { show: boolean | null; dismiss(): void } {
  const dismissed = usePreference(onboardingPreference) === 'done';
  const hydrated = useBoard(selectHydrated);
  const projects = useBoardList(selectProjects).length;
  const windows = useBoard(selectWindowCount);
  const [latched, setLatched] = useState(false);
  // Only an empty board can need the guide, so a busy one never asks.
  const status = useServerStatus(null, !dismissed && hydrated && projects === 0 && windows === 0);
  const decided = needsOnboarding({ dismissed, hydrated, projects, windows, status });
  if (decided === true && !latched) setLatched(true);
  return {
    show: dismissed ? false : latched || decided,
    dismiss: () => onboardingPreference.set('done'),
  };
}
