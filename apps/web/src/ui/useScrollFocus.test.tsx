// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useScrollFocus } from './useScrollFocus.js';

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
});

function Box({ label }: { label: string }) {
  const ref = useScrollFocus<HTMLPreElement>(label);
  return <pre ref={ref}>code</pre>;
}

/** happy-dom has no layout: give `pre` elements the sizes of a box whose content overflows. */
function sizePre(scrollWidth: number, clientWidth: number) {
  const proto = HTMLElement.prototype;
  const original = {
    scrollWidth: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'),
    clientWidth: Object.getOwnPropertyDescriptor(proto, 'clientWidth'),
  };
  Object.defineProperty(proto, 'scrollWidth', {
    configurable: true,
    get() {
      return this.tagName === 'PRE' ? scrollWidth : 0;
    },
  });
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get() {
      return this.tagName === 'PRE' ? clientWidth : 0;
    },
  });
  return () => {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
    }
  };
}

describe('useScrollFocus', () => {
  it('makes an overflowing box a labelled Tab stop', () => {
    const restore = sizePre(800, 300);
    act(() => root.render(<Box label="ts code" />));
    const pre = container.querySelector('pre');
    expect(pre?.tabIndex).toBe(0);
    expect(pre?.getAttribute('role')).toBe('region');
    expect(pre?.getAttribute('aria-label')).toBe('ts code');
    restore();
  });

  it('leaves a box that fits out of the Tab order', () => {
    const restore = sizePre(300, 300);
    act(() => root.render(<Box label="Code" />));
    const pre = container.querySelector('pre');
    expect(pre?.hasAttribute('tabindex')).toBe(false);
    expect(pre?.hasAttribute('role')).toBe(false);
    expect(pre?.hasAttribute('aria-label')).toBe(false);
    restore();
  });
});
