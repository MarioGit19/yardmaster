import { describe, expect, it } from 'vitest';
import type { SceneActor } from '../../../layouts/scene.js';
import { BAND_CREW, bandCrew, bandSelection, HUB_CREW } from './band.js';

const NOW = 1_760_000_000_000;

function actor(id: string, over: Partial<SceneActor> = {}): SceneActor {
  return {
    id,
    kind: 'terminal',
    projectId: 'p-acme',
    parentId: null,
    state: 'idle',
    token: 'quiet',
    tone: 'idle',
    activity: 0,
    label: id,
    caption: { glyph: null, text: 'Idle', tone: 'rest' },
    name: `acme-shop, ${id}, idle`,
    links: { href: '/', sessionId: null, terminalId: null, approvalId: null },
    since: NOW - 60_000,
    tool: null,
    toolSince: null,
    planning: false,
    ports: [],
    runningSince: null,
    exit: null,
    ...over,
  };
}

const claude = (id: string, over: Partial<SceneActor> = {}) =>
  actor(id, { kind: 'claude', state: 'typing', ...over });

describe('the Office band crew', () => {
  it('seats sessions then terminals, oldest first, and leaves helpers with their session', () => {
    const crew = bandCrew([
      actor('t:b', { since: NOW - 10 }),
      claude('s:2', { since: NOW - 20 }),
      actor('a:1', { kind: 'subagent', parentId: 's:1' }),
      actor('b:1', { kind: 'background', parentId: 's:1' }),
      actor('t:a', { since: NOW - 30 }),
      claude('s:1', { since: NOW - 40 }),
    ]);
    expect(crew.shown.map((a) => a.id)).toEqual(['s:1', 's:2', 't:a', 't:b']);
    expect(crew.hidden).toBe(0);
  });

  it(`caps at ${BAND_CREW}, keeping whoever needs attention, in the stable order`, () => {
    const actors = [
      ...Array.from({ length: 9 }, (_, i) => actor(`t:${i}`, { since: NOW - 100 + i })),
      claude('s:wait', { state: 'waiting', since: NOW }),
    ];
    const crew = bandCrew(actors);
    expect(crew.shown).toHaveLength(BAND_CREW);
    expect(crew.hidden).toBe(2);
    expect(crew.shown[0]?.id).toBe('s:wait');
    expect(crew.shown.slice(1).map((a) => a.id)).toEqual([
      't:0',
      't:1',
      't:2',
      't:3',
      't:4',
      't:5',
      't:6',
    ]);
  });

  it(`gives the phone hub ${HUB_CREW} at most`, () => {
    const crew = bandCrew(
      Array.from({ length: 5 }, (_, i) => actor(`t:${i}`)),
      HUB_CREW,
    );
    expect(crew.shown).toHaveLength(HUB_CREW);
    expect(crew.hidden).toBe(2);
  });

  it('selects a session by its route and a terminal by its tab', () => {
    const href = '/p/p-acme/s/1f0c';
    expect(
      bandSelection(
        claude('s:1', { links: { href, sessionId: '1f0c', terminalId: null, approvalId: null } }),
      ),
    ).toEqual({ kind: 'session', href });
    expect(
      bandSelection(
        actor('t:1', {
          links: { href: '/p/p-acme/t/9', sessionId: null, terminalId: '9', approvalId: null },
        }),
      ),
    ).toEqual({ kind: 'terminal', terminalId: '9' });
    expect(bandSelection(actor('t:x'))).toBeNull();
  });
});
