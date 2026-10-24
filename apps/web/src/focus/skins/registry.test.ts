// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { LAYOUTS } from '../../layouts/registry.js';
import { minimalSkin } from './minimal.js';
import { LAYOUT_SKIN, loadedSkin, loadSkin } from './registry.js';
import { KEY_TARGETS, numberTargets } from './retro/RetroSkin.js';

describe('workspace skins', () => {
  it('gives every layout its own skin', () => {
    for (const layout of LAYOUTS) expect(LAYOUT_SKIN[layout]).toBeDefined();
    expect(LAYOUT_SKIN.minimal).toBe('minimal');
    expect(LAYOUT_SKIN.retro).toBe('retro');
    expect(LAYOUT_SKIN.grid).toBe('grid');
    expect(LAYOUT_SKIN.office).toBe('office');
    expect(LAYOUT_SKIN.transit).toBe('transit');
  });

  it('has Minimal at once and keeps today’s view: no frame, no entry of its own', async () => {
    expect(loadedSkin('minimal')).toBe(minimalSkin);
    expect(await loadSkin('minimal')).toBe(minimalSkin);
    expect(minimalSkin.PanelFrame).toBeNull();
    expect(minimalSkin.EntryTransition).toBeNull();
  });

  it('loads Retro with its slots, once', async () => {
    const first = loadSkin('retro');
    expect(loadSkin('retro')).toBe(first);
    const retro = await first;
    expect(loadedSkin('retro')).toBe(retro);
    expect(retro.HeaderBand).toBeTypeOf('function');
    expect(retro.PanelFrame).toBeTypeOf('function');
    expect(retro.EntryTransition).toBeTypeOf('function');
  });

  it('loads Grid with its holo frame and its phase-in entry', async () => {
    const grid = await loadSkin('grid');
    expect(loadedSkin('grid')).toBe(grid);
    expect(grid.HeaderBand).toBeTypeOf('function');
    expect(grid.PanelFrame).toBeTypeOf('function');
    expect(grid.EntryTransition).toBeTypeOf('function');
  });

  it('loads Office with its monitors, its room entry and the phone hub crew', async () => {
    const office = await loadSkin('office');
    expect(loadedSkin('office')).toBe(office);
    expect(office.HeaderBand).toBeTypeOf('function');
    expect(office.PanelFrame).toBeTypeOf('function');
    expect(office.EntryTransition).toBeTypeOf('function');
    expect(office.HubCrew).toBeTypeOf('function');
  });
});

describe('Transit skin', () => {
  it('loads with its line band, flat panels, the line entry, the hub line and board words', async () => {
    const transit = await loadSkin('transit');
    expect(loadedSkin('transit')).toBe(transit);
    expect(transit.HeaderBand).toBeTypeOf('function');
    expect(transit.PanelFrame).toBeTypeOf('function');
    expect(transit.EntryTransition).toBeTypeOf('function');
    expect(transit.HubCrew).toBeTypeOf('function');
    expect(transit.statusWord?.({ kind: 'session', status: { kind: 'idle' } })).toBe('At platform');
    expect(minimalSkin.statusWord).toBeUndefined();
  });
});

describe('Retro number shortcuts', () => {
  it('number session rows first, then terminal tabs, in document order', () => {
    document.body.innerHTML = `
      <section><a data-session="s1" href="#a">a</a><a data-session="s2" href="#b">b</a></section>
      <section><div role="tablist"><button role="tab" data-tab="t1">t1</button></div></section>
      <a href="#x">other</a>`;
    expect(numberTargets(document).map((el) => el.dataset.session ?? el.dataset.tab)).toEqual([
      's1',
      's2',
      't1',
    ]);
    expect(document.querySelectorAll(KEY_TARGETS)).toHaveLength(3);
  });
});
