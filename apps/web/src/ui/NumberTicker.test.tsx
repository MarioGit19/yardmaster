// @vitest-environment happy-dom
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatCount } from '../status.js';
import { NumberTicker, rollTarget } from './NumberTicker.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

const strips = () => Array.from(container.querySelectorAll<HTMLElement>('[aria-hidden] .flex-col'));

describe('NumberTicker', () => {
  it('reads as the formatted value and draws one strip per digit', () => {
    act(() => root.render(<NumberTicker value={12_400} format={formatCount} />));
    expect(container.querySelector('.sr-only')?.textContent).toBe('12.4k');
    expect(strips()).toHaveLength(3);
    expect(container.querySelector('[aria-hidden]')?.textContent).toContain('.');
    expect(container.querySelector('[aria-hidden]')?.textContent).toContain('k');
  });

  it('moves each strip to its digit and keeps units in place as the number grows', async () => {
    act(() => root.render(<NumberTicker value={7} />));
    const ones = strips()[0];
    // Each of the strip's 20 cells is 5% of its height.
    expect(ones?.style.transform).toContain('-35%');
    act(() => root.render(<NumberTicker value={12} />));
    await settle();
    expect(strips()).toHaveLength(2);
    // The ones column is the same element, now on 2.
    expect(strips()[1]).toBe(ones);
    // 7 → 2 rolled forward through 0, onto the strip's second turn.
    expect(ones?.style.transform).toContain('-60%');
    expect(container.querySelector('[data-value]')?.getAttribute('data-value')).toBe('12');
    act(() => root.render(<NumberTicker value={9} />));
    await settle();
    // 2 → 9 as the value shrinks rolls down through 0 (from 12 to 9).
    expect(ones?.style.transform).toContain('-45%');
  });
});

describe('rollTarget', () => {
  it('rolls forward from 9 into the trailing 0 instead of back through every digit', () => {
    expect(rollTarget(9, 0, 1)).toEqual({ from: 9, to: 10 });
    expect(rollTarget(8, 2, 1)).toEqual({ from: 8, to: 12 });
    expect(rollTarget(3, 5, 1)).toEqual({ from: 3, to: 5 });
  });

  it('rolls down as the value shrinks, through 0 into 9 when it wraps', () => {
    expect(rollTarget(0, 9, -1)).toEqual({ from: 10, to: 9 });
    expect(rollTarget(5, 3, -1)).toEqual({ from: 15, to: 13 });
    expect(rollTarget(1, 9, -1)).toEqual({ from: 11, to: 9 });
  });

  it('picks up from a roll still in flight on either turn', () => {
    const inFlight = rollTarget(10.4, 1, 1);
    expect(inFlight.from).toBeCloseTo(0.4);
    expect(inFlight.to).toBe(1);
    expect(rollTarget(9.6, 0, 1).to).toBe(10);
    expect(rollTarget(12.5, 1, -1)).toEqual({ from: 12.5, to: 11 });
  });

  it('stays put when the digit did not change', () => {
    for (const dir of [1, -1] as const) {
      const { from, to } = rollTarget(4, 4, dir);
      expect(to - from).toBe(0);
    }
  });
});
