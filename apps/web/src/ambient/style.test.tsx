// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, BoardProvider, createBoardStore } from '../data/index.js';
import { webglSlot } from '../fx/webglSlot.js';
import { motionPreference } from '../motion.js';
import { createPreference } from '../prefs.js';
import { sampleBoard } from '../test/board.js';
import { AmbientField } from './AmbientField.js';
import { AMBIENT_STYLES, ambientStylePreference } from './style.js';

// A nebula renderer that always "works", so these tests see the WebGL path happy-dom lacks.
vi.mock('./renderer.js', async (load) => ({
  ...(await load<typeof import('./renderer.js')>()),
  createFieldRenderer: () => ({ draw() {}, dispose() {} }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  motionPreference.set('full');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  motionPreference.set('system');
  ambientStylePreference.set('nebula');
});

function render() {
  const store = createBoardStore();
  store.getState().replaceBoard(sampleBoard());
  const client = new BoardClient({ url: 'ws://test.invalid/ws/ui', store });
  act(() =>
    root.render(
      <BoardProvider client={client} store={store}>
        <AmbientField />
      </BoardProvider>,
    ),
  );
  return () => container.querySelector<HTMLElement>('[data-ambient]');
}

describe('ambient style', () => {
  it('defaults to the nebula and ignores unknown stored values', () => {
    const storage = new Map<string, string>([['cboard.ambient', 'lava-lamp']]);
    const pref = createPreference('cboard.ambient', AMBIENT_STYLES, 'nebula', {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    });
    expect(pref.get()).toBe('nebula');
  });

  it('runs the shader at Full', () => {
    const field = render();
    expect(field()?.dataset.ambient).toBe('webgl');
    expect(field()?.dataset.ambientStyle).toBe('nebula');
  });

  it('steps back to the CSS field while an fx effect holds the WebGL slot', () => {
    const field = render();
    let release = () => {};
    act(() => {
      release = webglSlot.claim();
    });
    expect(field()?.dataset.ambient).toBe('css');
    expect(field()?.querySelector('canvas')).toBeNull();
    act(() => release());
    expect(field()?.dataset.ambient).toBe('webgl');
  });

  it('shows the bare page with the None style', () => {
    ambientStylePreference.set('none');
    const field = render();
    expect(field()?.dataset.ambient).toBe('none');
    expect(field()?.childElementCount).toBe(0);
  });

  it('falls back to CSS when a style needs WebGL2 the browser lacks', () => {
    ambientStylePreference.set('veil');
    const field = render();
    expect(field()?.dataset.ambientStyle).toBe('veil');
    expect(field()?.dataset.ambient).toBe('css');
  });
});
