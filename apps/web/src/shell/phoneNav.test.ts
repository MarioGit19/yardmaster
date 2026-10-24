import { describe, expect, it } from 'vitest';
import { createHistoryTrack, isWorkspace, phoneTabFor } from './phoneNav.js';

/** A tiny history: push, back and forward, with per-entry state like the browser's. */
function fakeHistory() {
  const entries: { state: unknown; location: string }[] = [];
  let index = -1;
  const history = {
    get state() {
      return entries[index]?.state ?? null;
    },
    replaceState(state: unknown, _unused: string, url?: string | URL | null) {
      const entry = entries[index];
      if (entry) entry.state = state;
      if (entry && typeof url === 'string') entry.location = url.replace(/^#/, '');
    },
    pushState(state: unknown, _unused: string, url?: string | URL | null) {
      entries.splice(index + 1);
      entries.push({ state, location: typeof url === 'string' ? url.replace(/^#/, '') : '' });
      index++;
    },
  };
  return {
    history,
    entries,
    push(location: string) {
      entries.splice(index + 1);
      entries.push({ state: null, location });
      index++;
      return location;
    },
    go(delta: number) {
      index += delta;
      return entries[index]?.location ?? '';
    },
  };
}

describe('phoneTabFor', () => {
  it('maps the tab routes, puts Settings under More and nothing else', () => {
    expect(phoneTabFor('/')).toBe('overview');
    expect(phoneTabFor('/projects')).toBe('projects');
    expect(phoneTabFor('/attention')).toBe('attention');
    expect(phoneTabFor('/pulse')).toBe('pulse');
    expect(phoneTabFor('/more')).toBe('more');
    expect(phoneTabFor('/settings')).toBe('more');
    expect(phoneTabFor('/welcome')).toBeNull();
    expect(phoneTabFor('/p/p-acme')).toBeNull();
  });

  it('knows a workspace by its route', () => {
    expect(isWorkspace('/p/p-acme/s/s-1')).toBe(true);
    expect(isWorkspace('/projects')).toBe(false);
  });
});

describe('createHistoryTrack', () => {
  it('goes back past every workspace entry to the tab the project was opened from', () => {
    const browser = fakeHistory();
    const track = createHistoryTrack(browser.history);
    for (const location of ['/', '/projects', '/p/a', '/p/a/s/1', '/p/a/t/2']) {
      track.visit(browser.push(location));
    }
    expect(track.stepsToLeaveWorkspace()).toBe(-3);
  });

  it('reads the stamp of an entry it reached by going back', () => {
    const browser = fakeHistory();
    const track = createHistoryTrack(browser.history);
    for (const location of ['/', '/p/a', '/p/a/s/1']) track.visit(browser.push(location));
    track.visit(browser.go(-1));
    expect(track.stepsToLeaveWorkspace()).toBe(-1);
    // A new branch from there replaces what was ahead.
    track.visit(browser.push('/pulse'));
    track.visit(browser.push('/p/b'));
    expect(track.stepsToLeaveWorkspace()).toBe(-1);
  });

  it('slides the hub under a deep-linked item page, so back lands on it', () => {
    const browser = fakeHistory();
    const track = createHistoryTrack(browser.history);
    track.visit(browser.push('/'));
    track.visit(browser.push('/p/a/s/1'));
    track.placeBelow('/p/a');
    expect(browser.entries.map((e) => e.location)).toEqual(['/', '/p/a', '/p/a/s/1']);
    expect(track.previous()).toBe('/p/a');
    expect(track.stepsToLeaveWorkspace()).toBe(-2);
    track.visit(browser.go(-1));
    expect(track.stepsToLeaveWorkspace()).toBe(-1);
    // Already on the hub: nothing to slide under it.
    track.placeBelow('/p/a');
    expect(browser.entries).toHaveLength(3);
  });

  it('has nowhere to go back to after a direct link into a workspace', () => {
    const browser = fakeHistory();
    const track = createHistoryTrack(browser.history);
    track.visit(browser.push('/p/a'));
    track.visit(browser.push('/p/a/s/1'));
    expect(track.stepsToLeaveWorkspace()).toBeNull();
  });

  it('stops at entries from before a reload, which it never saw', () => {
    const browser = fakeHistory();
    const before = createHistoryTrack(browser.history);
    for (const location of ['/', '/p/a']) before.visit(browser.push(location));
    // The page reloads: a new track, the same history and stamps.
    const after = createHistoryTrack(browser.history);
    after.visit('/p/a');
    expect(after.stepsToLeaveWorkspace()).toBeNull();
  });
});
