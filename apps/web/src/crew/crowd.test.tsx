// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CROWD_SIZE, useCrewCrowd } from './crowd.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Member({ active }: { active: boolean }) {
  useCrewCrowd(active);
  return null;
}

function render(count: number, active = true) {
  act(() =>
    root.render(
      Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: interchangeable test members.
        <Member key={i} active={active} />
      )),
    ),
  );
}

const crowded = () => document.documentElement.hasAttribute('data-crew-crowd');

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useCrewCrowd', () => {
  it('marks the root only while more than the crowd size animate', () => {
    render(CROWD_SIZE);
    expect(crowded()).toBe(false);
    render(CROWD_SIZE + 1);
    expect(crowded()).toBe(true);
    render(CROWD_SIZE);
    expect(crowded()).toBe(false);
  });

  it('ignores crew that are paused or off screen', () => {
    render(CROWD_SIZE + 5, false);
    expect(crowded()).toBe(false);
  });

  it('clears the mark on unmount', () => {
    render(CROWD_SIZE + 1);
    act(() => root.unmount());
    expect(crowded()).toBe(false);
    root = createRoot(container);
  });
});
