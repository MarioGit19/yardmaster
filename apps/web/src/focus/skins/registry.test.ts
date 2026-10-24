// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { LAYOUTS } from '../../layouts/registry.js';
import { minimalSkin } from './minimal.js';
import { LAYOUT_SKIN, loadedSkin, loadSkin } from './registry.js';
import { KEY_TARGETS, numberTargets } from './retro/RetroSkin.js';

describe('workspace skins', () => {
  it('gives every layout a skin, Minimal for those without their own yet', () => {
    for (const layout of LAYOUTS) expect(LAYOUT_SKIN[layout]).toBeDefined();
    expect(LAYOUT_SKIN.minimal).toBe('minimal');
    expect(LAYOUT_SKIN.retro).toBe('retro');
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
