import type { HookEventStatus, ServerStatus } from '@c-board/protocol';
import { createPreference } from '../prefs.js';

export type StepId = 'server' | 'hooks' | 'extension';

export interface SetupStep {
  id: StepId;
  done: boolean;
}

export interface SetupSignals {
  /** The UI socket is live. */
  connected: boolean;
  status: ServerStatus | null;
  /** Editor windows connected right now (from the board snapshot, so it ticks instantly). */
  windows: number;
}

/** DESIGN.md §6: Server, Hooks, Extension. Each ticks as soon as the board sees it working. */
export function setupSteps({ connected, status, windows }: SetupSignals): SetupStep[] {
  const hookSeen = Boolean(status && (status.setup.hookSeen || status.hooks.received > 0));
  const editorSeen = windows > 0 || Boolean(status && (status.setup.editorSeen || status.editors));
  return [
    { id: 'server', done: connected },
    { id: 'hooks', done: hookSeen },
    { id: 'extension', done: editorSeen },
  ];
}

/** The step to work on next, or null when everything is done. */
export function activeStep(steps: SetupStep[]): StepId | null {
  return steps.find((step) => !step.done)?.id ?? null;
}

/** Every observer event is installed and current. */
export function hooksInstalled(status: HookEventStatus | null): boolean {
  return status !== null && status.missing.length === 0 && status.outdated.length === 0;
}

export interface OnboardingSignals {
  dismissed: boolean;
  hydrated: boolean;
  projects: number;
  windows: number;
  /** Null until `/api/status` answers; `'error'` when it can't. */
  status: ServerStatus | null | 'error';
}

/**
 * First run: nothing has ever reached the board. Returns null while that can't be told yet.
 * Existing data (projects, editors, past hook events) means the board is already set up.
 */
export function needsOnboarding(s: OnboardingSignals): boolean | null {
  if (s.dismissed) return false;
  if (!s.hydrated) return null;
  if (s.projects > 0 || s.windows > 0) return false;
  if (s.status === null) return null;
  if (s.status === 'error' || s.status.demo) return false;
  return !s.status.setup.hookSeen && !s.status.setup.editorSeen;
}

/** Set once the user finishes or skips the setup guide on the overview. */
export const onboardingPreference = createPreference<'pending' | 'done'>(
  'cboard.onboarding',
  ['pending', 'done'],
  'pending',
);

/** Commands shown in the guide; the user runs them from the c-board checkout. */
export const SETUP_COMMANDS = {
  hooks: 'pnpm c-board hooks install',
  extension: [
    'pnpm --filter c-board-extension package',
    'cursor --install-extension apps/extension/dist/c-board.vsix',
  ],
} as const;
