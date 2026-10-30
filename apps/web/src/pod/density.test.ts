import { type ClaudeSession, emptyBoardState, type SeenResponse } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { activityKey } from '../data/index.js';
import { createPreference } from '../prefs.js';
import { makeProject, makeSession } from '../test/board.js';
import { DIM_AFTER_MS } from './activity.js';
import { DENSITIES, podForm, quietProjects } from './density.js';

const NOW = 1_800_000_000_000;
const SEEN: SeenResponse = { since: NOW, marks: {} };
const OLD = NOW - DIM_AFTER_MS - 1;

function state(projectLast: number | null, kind: 'idle' | 'working' | 'waiting_input' | null) {
  const project = { ...makeProject('p-1', 'acme-shop'), lastActivityAt: projectLast };
  const board = { ...emptyBoardState(), projects: { 'p-1': project } };
  if (kind) {
    const status = { kind } as ClaudeSession['status'];
    const session = {
      ...makeSession('s-1', 'p-1', status),
      updatedAt: NOW,
      lastAssistantAt: null,
    };
    board.sessions = { 's-1': session };
  }
  return { board, pulses: {} };
}

describe('podForm', () => {
  it('folds quiet projects, and every project in List', () => {
    expect(podForm('comfortable', false)).toBe('card');
    expect(podForm('comfortable', true)).toBe('row');
    expect(podForm('compact', false)).toBe('card');
    expect(podForm('compact', true)).toBe('row');
    expect(podForm('list', false)).toBe('row');
  });
});

describe('quietProjects', () => {
  it('counts a project with nothing recent and nothing going on', () => {
    expect(quietProjects(state(OLD, 'idle'), ['p-1'], SEEN, NOW)).toEqual(['p-1']);
    expect(quietProjects(state(null, null), ['p-1'], SEEN, NOW)).toEqual(['p-1']);
  });

  it('keeps a recently active project as a card', () => {
    expect(quietProjects(state(NOW - 1000, 'idle'), ['p-1'], SEEN, NOW)).toEqual([]);
  });

  it('keeps work and waits as cards however old the last activity is', () => {
    expect(quietProjects(state(OLD, 'working'), ['p-1'], SEEN, NOW)).toEqual([]);
    expect(quietProjects(state(OLD, 'waiting_input'), ['p-1'], SEEN, NOW)).toEqual([]);
  });

  it('counts a live pulse as activity', () => {
    const quiet = state(OLD, 'idle');
    const pulses = {
      [activityKey.project('p-1')]: { energy: 0, at: NOW, lastAt: NOW, events: 1, doneAt: null },
    };
    expect(quietProjects({ ...quiet, pulses }, ['p-1'], SEEN, NOW)).toEqual([]);
  });
});

describe('the density preference', () => {
  it('survives a reload and ignores an unknown stored value', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    createPreference('density', DENSITIES, 'comfortable', storage).set('list');
    expect(createPreference('density', DENSITIES, 'comfortable', storage).get()).toBe('list');
    values.set('density', 'huge');
    expect(createPreference('density', DENSITIES, 'comfortable', storage).get()).toBe(
      'comfortable',
    );
  });
});
