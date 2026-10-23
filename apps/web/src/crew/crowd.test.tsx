// @vitest-environment happy-dom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CROWD_SIZE, useCrewCrowd } from './crowd.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Member({ active }: { active: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useCrewCrowd(active, ref);
  return <span ref={ref} data-member />;
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

const members = () => [...container.querySelectorAll('[data-member]')];
/** Every member carries the mark, or none does. */
const crowded = () => {
  const marked = members().filter((m) => m.hasAttribute('data-crew-crowd')).length;
  if (marked && marked !== members().length) throw new Error(`${marked} members marked`);
  return marked > 0;
};

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
  it('marks the members only while more than the crowd size animate', () => {
    render(CROWD_SIZE);
    expect(crowded()).toBe(false);
    render(CROWD_SIZE + 1);
    expect(crowded()).toBe(true);
    render(CROWD_SIZE + 3);
    expect(crowded()).toBe(true);
    render(CROWD_SIZE);
    expect(crowded()).toBe(false);
  });

  it('leaves the document alone', () => {
    render(CROWD_SIZE + 1);
    expect(document.documentElement.hasAttribute('data-crew-crowd')).toBe(false);
  });

  it('ignores crew that are paused or off screen', () => {
    render(CROWD_SIZE + 5, false);
    expect(crowded()).toBe(false);
  });

  it('clears the mark when a member pauses', () => {
    render(CROWD_SIZE + 1);
    act(() =>
      root.render(
        Array.from({ length: CROWD_SIZE + 1 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: interchangeable test members.
          <Member key={i} active={i > 0} />
        )),
      ),
    );
    expect(members().some((m) => m.hasAttribute('data-crew-crowd'))).toBe(false);
  });
});
