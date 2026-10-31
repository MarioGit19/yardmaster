import type { BoardSettings } from '@yardmaster/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createBoardSettingsStore } from './boardSettings.js';

const BASE: BoardSettings = {
  retentionDays: 7,
  usageWarnFiveHour: 80,
  usageWarnSevenDay: 80,
  awayMode: false,
  awayTimeoutSec: 120,
  terminalReply: false,
  libraryRoots: [],
  editorCli: null,
  remoteAllowedHosts: [],
  libraryIdleHideMin: 30,
  pinnedProjects: [],
  notifyEvents: ['needs_you'],
  notifyHideDetails: false,
  notifyMutedProjects: [],
};

describe('createBoardSettingsStore', () => {
  it('shares one request between concurrent loads and notifies subscribers', async () => {
    const fetch = vi.fn(async () => BASE);
    const store = createBoardSettingsStore({ fetch, save: async () => BASE });
    const listener = vi.fn();
    store.subscribe(listener);
    await Promise.all([store.load(), store.load()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual(BASE);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('applies a patch at once and keeps what the server answers', async () => {
    const store = createBoardSettingsStore({
      fetch: async () => BASE,
      save: async (patch) => ({ ...BASE, ...patch }),
    });
    await store.load();
    const saving = store.update({ terminalReply: true });
    expect(store.get()?.terminalReply).toBe(true);
    expect(await saving).toBe(true);
    expect(store.get()?.terminalReply).toBe(true);
  });

  it('rolls a failed save back', async () => {
    const store = createBoardSettingsStore({
      fetch: async () => BASE,
      save: async () => {
        throw new Error('offline');
      },
    });
    await store.load();
    expect(await store.update({ terminalReply: true })).toBe(false);
    expect(store.get()).toEqual(BASE);
  });

  it('keeps the last settings when a reload fails', async () => {
    let fail = false;
    const store = createBoardSettingsStore({
      fetch: async () => {
        if (fail) throw new Error('offline');
        return BASE;
      },
      save: async () => BASE,
    });
    await store.load();
    fail = true;
    await store.load();
    expect(store.get()).toEqual(BASE);
  });
});
