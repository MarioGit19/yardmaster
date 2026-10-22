// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { motionPreference } from '../motion.js';
import { DecryptedText, decryptFrame, SCRAMBLE_GLYPHS } from './DecryptedText.js';
import { glitchFrames } from './GlitchText.js';
import { parseHex } from './gl.js';
import { HoldButton } from './HoldButton.js';
import { ShaderStage } from './ShaderStage.js';
import { boardText, flipSequence, SplitFlapText } from './SplitFlapText.js';
import { rubber, swipeOffset, swipeOutcome } from './SwipeRow.js';
import { createWebglSlot, webglSlot } from './webglSlot.js';

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
  vi.useRealTimers();
});

describe('webglSlot', () => {
  it('is claimed while any claim is held, and notifies only on changes', () => {
    const slot = createWebglSlot();
    const listener = vi.fn();
    slot.subscribe(listener);
    const a = slot.claim();
    const b = slot.claim();
    expect(slot.claimed()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    a();
    a();
    expect(slot.claimed()).toBe(true);
    b();
    expect(slot.claimed()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('ShaderStage', () => {
  const stage = () =>
    act(() =>
      root.render(
        <ShaderStage
          create={() => null}
          fallback={<div data-testid="fallback" />}
          className="h-10"
        />,
      ),
    );

  it('creates no context at Off and leaves the ambient field its slot', () => {
    motionPreference.set('off');
    stage();
    const element = container.querySelector<HTMLElement>('[data-fx-stage]');
    expect(element?.dataset.fxStage).toBe('off');
    expect(element?.querySelector('canvas')).toBeNull();
    expect(element?.querySelector('[data-testid="fallback"]')).not.toBeNull();
    expect(webglSlot.claimed()).toBe(false);
  });

  it('holds the WebGL slot while its canvas is live', () => {
    motionPreference.set('reduced');
    stage();
    expect(container.querySelector('[data-fx-stage] canvas')).not.toBeNull();
    expect(webglSlot.claimed()).toBe(true);
    act(() => root.render(null));
    expect(webglSlot.claimed()).toBe(false);
  });
});

describe('DecryptedText', () => {
  it('keeps resolved text, scrambles the rest and leaves spaces alone', () => {
    const { done, tail } = decryptFrame('pnpm run test', 5, () => 0);
    expect(done).toBe('pnpm ');
    expect(tail).toHaveLength('run test'.length);
    expect(tail[3]).toBe(' ');
    expect(tail.replace(/ /g, '')).toMatch(new RegExp(`^[${SCRAMBLE_GLYPHS[0]}]+$`));
    expect(decryptFrame('done', 4).tail).toBe('');
  });

  it('shows the final text at once below Full, and to screen readers always', () => {
    motionPreference.set('reduced');
    act(() => root.render(<DecryptedText text="Editing src/cart.ts" />));
    act(() => root.render(<DecryptedText text="Running pnpm test" />));
    const element = container.querySelector('[data-fx="decrypted"]');
    expect(element?.querySelector('.sr-only')?.textContent).toBe('Running pnpm test');
    expect(element?.querySelector('[aria-hidden]')?.textContent).toBe('Running pnpm test');
  });
});

describe('GlitchText', () => {
  it('keeps every slice small and inside the text box', () => {
    const frames = glitchFrames(Math.random, 50);
    for (const frame of frames) {
      for (const offset of [frame.ax, frame.bx]) {
        expect(Math.abs(offset)).toBeGreaterThanOrEqual(1.5);
        expect(Math.abs(offset)).toBeLessThanOrEqual(3);
      }
      for (const [top, bottom] of [frame.a, frame.b]) {
        expect(top).toBeGreaterThanOrEqual(0);
        expect(bottom).toBeGreaterThanOrEqual(0);
        expect(top + bottom).toBeLessThan(100);
      }
    }
  });
});

describe('SplitFlapText', () => {
  it('fits text to the board', () => {
    expect(boardText('waiting', 9)).toBe('WAITING  ');
    expect(boardText('acme-shop-checkout', 9)).toBe('ACME-SHOP');
  });

  it('flips through random glyphs and lands on the target', () => {
    const steps = flipSequence('D', 3, 'XYZ', () => 0);
    expect(steps).toEqual(['X', 'X', 'X', 'D']);
  });

  it('swaps without flipping below Full', () => {
    motionPreference.set('off');
    act(() => root.render(<SplitFlapText text="WORKING" />));
    act(() => root.render(<SplitFlapText text="WAITING" />));
    const board = container.querySelector('[data-fx="split-flap"]');
    expect(board?.querySelectorAll('[data-flipping]')).toHaveLength(0);
    const tops = [...(board?.querySelectorAll('.fx-flap-top') ?? [])].map((t) => t.textContent);
    expect(tops.join('')).toBe('WAITING');
  });
});

describe('SwipeRow', () => {
  const both = { left: true, right: true };

  it('follows the finger up to the threshold, then rubber-bands', () => {
    expect(swipeOffset(80, 390, 156, both)).toBe(80);
    const past = swipeOffset(300, 390, 156, both);
    expect(past).toBeGreaterThan(156);
    expect(past).toBeLessThan(300);
    expect(rubber(100, 390)).toBeLessThan(100);
  });

  it('resists a swipe toward a side without an action', () => {
    expect(Math.abs(swipeOffset(-120, 390, 156, { left: false, right: true }))).toBeLessThan(40);
  });

  it('commits past the threshold or on a flick from halfway', () => {
    expect(swipeOutcome(160, 0, 156, both)).toBe('right');
    expect(swipeOutcome(-160, 0, 156, both)).toBe('left');
    expect(swipeOutcome(90, 0, 156, both)).toBeNull();
    expect(swipeOutcome(90, 900, 156, both)).toBe('right');
    expect(swipeOutcome(90, -900, 156, both)).toBeNull();
    expect(swipeOutcome(160, 0, 156, { left: true, right: false })).toBeNull();
  });
});

describe('HoldButton', () => {
  const press = (button: HTMLButtonElement, type: 'keydown' | 'keyup') =>
    act(() => {
      button.dispatchEvent(new KeyboardEvent(type, { key: ' ', bubbles: true }));
    });

  it('fires only after a full hold, from the keyboard too', () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    act(() =>
      root.render(
        <HoldButton onHold={onHold} holdMs={1000}>
          Hold to stop
        </HoldButton>,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>('[data-fx="hold-button"]');
    if (!button) throw new Error('no button');

    press(button, 'keydown');
    act(() => vi.advanceTimersByTime(600));
    press(button, 'keyup');
    act(() => vi.advanceTimersByTime(1000));
    expect(onHold).not.toHaveBeenCalled();
    expect(button.dataset.phase).toBe('idle');

    press(button, 'keydown');
    act(() => vi.advanceTimersByTime(1000));
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(button.dataset.phase).toBe('done');
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
  });
});

describe('parseHex', () => {
  it('reads short and long hex colors', () => {
    expect(parseHex('#fff')).toEqual([1, 1, 1]);
    expect(parseHex('#000000')).toEqual([0, 0, 0]);
    expect(parseHex('oklch(0.7 0.1 200)')).toBeNull();
  });
});
