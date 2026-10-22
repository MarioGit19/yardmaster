// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardClient, BoardProvider, createBoardStore } from '../data/index.js';
import { motionPreference } from '../motion.js';
import { sampleBoard } from '../test/board.js';
import { AmbientField } from './AmbientField.js';
import { ambientOverride } from './debug.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  motionPreference.set('system');
  ambientOverride.set({ energy: null, attention: null });
});

function render(board = sampleBoard()) {
  const store = createBoardStore();
  store.getState().replaceBoard(board);
  const client = new BoardClient({ url: 'ws://test.invalid/ws/ui', store });
  act(() =>
    root.render(
      <BoardProvider client={client} store={store}>
        <AmbientField />
      </BoardProvider>,
    ),
  );
  return container.querySelector<HTMLElement>('[data-ambient]');
}

describe('AmbientField', () => {
  it('is a static CSS field without a canvas at Reduced motion', () => {
    motionPreference.set('reduced');
    const field = render();
    expect(field?.dataset.ambient).toBe('css');
    expect(field?.querySelector('canvas')).toBeNull();
    expect(field?.getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to the CSS field when WebGL is unavailable', () => {
    motionPreference.set('full');
    const field = render();
    expect(field?.dataset.ambient).toBe('css');
    expect(field?.querySelector('canvas')).toBeNull();
  });

  it('feeds energy and attention from the board into the CSS field', () => {
    motionPreference.set('off');
    const field = render();
    // One working and one waiting session in the sample board.
    expect(Number(field?.style.getPropertyValue('--ambient-energy'))).toBeGreaterThan(0);
    expect(field?.style.getPropertyValue('--ambient-attention')).toBe('1');
  });

  it('follows the debug override', () => {
    motionPreference.set('reduced');
    const field = render();
    act(() => ambientOverride.set({ energy: 0.25, attention: false }));
    expect(field?.style.getPropertyValue('--ambient-energy')).toBe('0.25');
    expect(field?.style.getPropertyValue('--ambient-attention')).toBe('0');
  });
});
