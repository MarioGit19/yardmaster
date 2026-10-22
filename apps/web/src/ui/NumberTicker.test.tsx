// @vitest-environment happy-dom
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatCount } from '../status.js';
import { NumberTicker } from './NumberTicker.js';

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
    expect(ones?.style.transform).toContain('-70%');
    act(() => root.render(<NumberTicker value={12} />));
    await settle();
    expect(strips()).toHaveLength(2);
    // The ones column is the same element, now on 2.
    expect(strips()[1]).toBe(ones);
    expect(ones?.style.transform).toContain('-20%');
    expect(container.querySelector('[data-value]')?.getAttribute('data-value')).toBe('12');
  });
});
