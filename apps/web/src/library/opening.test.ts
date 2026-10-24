import type { BoardState, EditorWindow } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import {
  createOpeningStore,
  hasWindow,
  OPENING_GIVE_UP_MS,
  OPENING_HINT_MS,
  openingPhase,
  settledOpenings,
  slowHint,
} from './opening.js';

const T0 = 1_760_000_000_000;

function window(id: string, projectIds: string[]): EditorWindow {
  return {
    id,
    appName: 'Cursor',
    appVersion: '1.93.0',
    extensionVersion: '0.1.0',
    workspaceFolders: [],
    projectIds,
    capabilities: { shellExecution: true },
    connectedAt: T0,
    lastSeenAt: T0,
  };
}

describe('opening in the editor', () => {
  it('shows "opening", then the hint, then gives up', () => {
    const opening = { editor: 'Cursor' as const, since: T0 };
    expect(openingPhase(opening, T0)).toBe('opening');
    expect(openingPhase(opening, T0 + OPENING_HINT_MS - 1)).toBe('opening');
    expect(openingPhase(opening, T0 + OPENING_HINT_MS)).toBe('slow');
    expect(openingPhase(opening, T0 + OPENING_GIVE_UP_MS)).toBeNull();
    expect(slowHint('VS Code')).toContain('VS Code');
  });

  it('settles a launch once its window connects, or once it gave up', () => {
    const openings = new Map([
      ['shop', { editor: 'Cursor' as const, since: T0 }],
      ['api', { editor: 'Cursor' as const, since: T0 }],
      ['old', { editor: 'VS Code' as const, since: T0 - OPENING_GIVE_UP_MS }],
    ]);
    const windows: BoardState['windows'] = { w1: window('w1', ['shop']) };
    expect(hasWindow(windows, 'shop')).toBe(true);
    expect(hasWindow(windows, 'api')).toBe(false);
    expect(settledOpenings(openings, windows, T0 + 1_000)).toEqual(['shop', 'old']);
  });

  it('keeps one entry per project and notifies only on a change', () => {
    const store = createOpeningStore();
    let changes = 0;
    store.subscribe(() => {
      changes += 1;
    });
    store.start('shop', { editor: 'Cursor', since: T0 });
    store.start('shop', { editor: 'Cursor', since: T0 + 5 });
    expect(store.get().get('shop')?.since).toBe(T0 + 5);
    store.clear(['api']);
    expect(changes).toBe(2);
    store.clear(['shop']);
    expect(store.get().size).toBe(0);
    expect(changes).toBe(3);
  });
});
