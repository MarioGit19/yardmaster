// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { scrollsSideways, swipeStep } from './swipe.js';

describe('swipeStep', () => {
  it('reads a quick sideways swipe as the next or previous tab', () => {
    expect(swipeStep(-120, 10, 200)).toBe(1);
    expect(swipeStep(120, -20, 200)).toBe(-1);
  });

  it('ignores short, steep or slow drags', () => {
    expect(swipeStep(-40, 0, 100)).toBe(0);
    expect(swipeStep(-120, 100, 200)).toBe(0);
    expect(swipeStep(-120, 0, 1200)).toBe(0);
  });
});

describe('scrollsSideways', () => {
  it('leaves text fields and the terminal their own drags', () => {
    const panel = document.createElement('div');
    panel.innerHTML =
      '<div class="xterm"><span id="cell"></span></div><textarea></textarea><p></p>';
    document.body.append(panel);
    expect(scrollsSideways(panel.querySelector('#cell'), panel)).toBe(true);
    expect(scrollsSideways(panel.querySelector('textarea'), panel)).toBe(true);
    expect(scrollsSideways(panel.querySelector('p'), panel)).toBe(false);
    panel.remove();
  });
});
