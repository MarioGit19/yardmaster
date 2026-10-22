import type { ServerStatus } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { activeStep, hooksInstalled, needsOnboarding, setupSteps } from './model.js';

function status(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    ok: true,
    version: '0.0.0',
    demo: false,
    uptimeMs: 1000,
    editors: 0,
    hooks: { received: 0, lastAt: null },
    setup: { hookSeen: false, editorSeen: false },
    ...overrides,
  };
}

describe('setupSteps', () => {
  it('ticks each step from its own signal', () => {
    expect(setupSteps({ connected: false, status: null, windows: 0 })).toEqual([
      { id: 'server', done: false },
      { id: 'hooks', done: false },
      { id: 'extension', done: false },
    ]);
    const hooked = status({ hooks: { received: 1, lastAt: 1 } });
    expect(setupSteps({ connected: true, status: hooked, windows: 0 }).map((s) => s.done)).toEqual([
      true,
      true,
      false,
    ]);
    // A window in the snapshot ticks the extension before the next status poll.
    expect(setupSteps({ connected: true, status: null, windows: 1 }).map((s) => s.done)).toEqual([
      true,
      false,
      true,
    ]);
    const remembered = status({ setup: { hookSeen: true, editorSeen: true } });
    expect(
      setupSteps({ connected: true, status: remembered, windows: 0 }).every((s) => s.done),
    ).toBe(true);
  });

  it('points at the first unfinished step', () => {
    expect(activeStep(setupSteps({ connected: true, status: status(), windows: 0 }))).toBe('hooks');
    expect(activeStep(setupSteps({ connected: true, status: status(), windows: 2 }))).toBe('hooks');
    const all = setupSteps({
      connected: true,
      status: status({ setup: { hookSeen: true, editorSeen: false } }),
      windows: 1,
    });
    expect(activeStep(all)).toBeNull();
  });
});

describe('hooksInstalled', () => {
  it('needs every event current', () => {
    expect(hooksInstalled(null)).toBe(false);
    expect(hooksInstalled({ installed: ['Stop'], missing: [], outdated: [] })).toBe(true);
    expect(hooksInstalled({ installed: [], missing: ['Stop'], outdated: [] })).toBe(false);
    expect(hooksInstalled({ installed: [], missing: [], outdated: ['Stop'] })).toBe(false);
  });
});

describe('needsOnboarding', () => {
  const fresh = { dismissed: false, hydrated: true, projects: 0, windows: 0, status: status() };

  it('shows on a board nothing has ever reached', () => {
    expect(needsOnboarding(fresh)).toBe(true);
  });

  it('waits for the snapshot and the status', () => {
    expect(needsOnboarding({ ...fresh, hydrated: false })).toBeNull();
    expect(needsOnboarding({ ...fresh, status: null })).toBeNull();
  });

  it('stays hidden once set up, skipped, in demo mode or when the status fails', () => {
    expect(needsOnboarding({ ...fresh, dismissed: true })).toBe(false);
    expect(needsOnboarding({ ...fresh, projects: 1, status: null })).toBe(false);
    expect(needsOnboarding({ ...fresh, windows: 1 })).toBe(false);
    expect(
      needsOnboarding({
        ...fresh,
        status: status({ setup: { hookSeen: true, editorSeen: false } }),
      }),
    ).toBe(false);
    expect(
      needsOnboarding({
        ...fresh,
        status: status({ setup: { hookSeen: false, editorSeen: true } }),
      }),
    ).toBe(false);
    expect(needsOnboarding({ ...fresh, status: status({ demo: true }) })).toBe(false);
    expect(needsOnboarding({ ...fresh, status: 'error' })).toBe(false);
  });
});
