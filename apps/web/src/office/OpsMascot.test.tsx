// @vitest-environment happy-dom
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { motionPreference } from '../motion.js';
import { OpsMascot, type OpsMascotProps } from './OpsMascot.js';
import { OPS_DONE_MS, OPS_STATES, OPS_X_EYES_MS } from './ops.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // happy-dom's WAAPI rejects Motion's cancelled animations; poses only need to mount.
  MotionGlobalConfig.skipAnimations = true;
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  motionPreference.set('full');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  motionPreference.set('system');
  vi.useRealTimers();
});

/** A fresh mount, so nothing is still leaving from the previous state. */
function fresh(props: OpsMascotProps) {
  act(() => root.unmount());
  root = createRoot(container);
  return render(props);
}

function render(props: OpsMascotProps) {
  act(() => root.render(<OpsMascot {...props} />));
  return container.querySelector<HTMLElement>('[data-ops]');
}

/** A fingerprint of what a state draws at a size: visor color, eyes and props. */
function look(props: OpsMascotProps): string {
  const ops = fresh(props);
  const color = ops?.style.getPropertyValue('--crew-color');
  const eyes = ops?.querySelector('[data-ops] span g')?.innerHTML ?? '';
  const props_ = [
    ops?.querySelector('[data-kit-leds]') ? 'leds' : '',
    ops?.querySelector('[data-kit-scroll]') ? 'screen' : '',
    ops?.querySelector('circle[r="9"][fill="var(--st-wait)"]') ? 'alert' : '',
    ops?.querySelector('.crew-z') ? 'z' : '',
    ops?.querySelector('.crew-spark') ? 'check' : '',
    ops?.querySelector('[data-ops-exit]') ? 'exit' : '',
  ].join(',');
  return `${color}|${eyes}|${props_}`;
}

describe('OpsMascot', () => {
  it('labels its state and sizes itself', () => {
    const ops = render({ state: 'error', exit: 2, size: 56 });
    expect(ops?.getAttribute('role')).toBe('img');
    expect(ops?.getAttribute('aria-label')).toBe('Failed with exit 2');
    expect(ops?.style.width).toBe('56px');
    expect(ops?.dataset.crewDetail).toBe('acting');
  });

  it('wears a headset, not the antenna orb', () => {
    const ops = render({ state: 'idle' });
    expect(ops?.querySelector('[data-orb]')).toBeNull();
    expect(ops?.querySelector('path[d^="M27.5 46"]')).not.toBeNull();
  });

  it('puts the status color on the visor', () => {
    expect(render({ state: 'running' })?.style.getPropertyValue('--crew-color')).toBe(
      'var(--st-tool)',
    );
    expect(render({ state: 'waiting' })?.style.getPropertyValue('--crew-color')).toBe(
      'var(--st-wait)',
    );
    expect(
      render({ state: 'waiting', color: 'var(--accent-2)' })?.style.getPropertyValue(
        '--crew-color',
      ),
    ).toBe('var(--accent-2)');
  });

  it('draws every state differently at 56 px', () => {
    const looks = OPS_STATES.map((state) =>
      look({ state, size: 56, exit: state === 'error' ? 1 : null, settle: false }),
    );
    expect(new Set(looks).size).toBe(OPS_STATES.length);
  });

  it('shows its station props: the rack when serving, the screen when running', () => {
    expect(
      render({ state: 'serving', activity: 0.5 })?.querySelectorAll('[data-kit-leds]'),
    ).toHaveLength(3);
    expect(render({ state: 'running' })?.querySelector('[data-kit-scroll]')).not.toBeNull();
    expect(
      fresh({ state: 'idle' })?.querySelector('[data-kit-scroll], [data-kit-leds]'),
    ).toBeNull();
  });

  it('keeps only posture and the visor color at 24 px', () => {
    const ops = render({ state: 'waiting', size: 24 });
    expect(ops?.dataset.crewDetail).toBe('posture');
    expect(ops?.querySelector('circle[r="9"][fill="var(--st-wait)"]')).toBeNull();
    expect(ops?.style.getPropertyValue('--crew-color')).toBe('var(--st-wait)');
  });

  it('settles done into idle once', () => {
    vi.useFakeTimers();
    expect(render({ state: 'done' })?.dataset.ops).toBe('done');
    act(() => vi.advanceTimersByTime(OPS_DONE_MS));
    expect(container.querySelector('[data-ops]')?.getAttribute('data-ops')).toBe('idle');
  });

  it('shows ×-eyes on error, then a worried look, with the exit badge throughout', () => {
    vi.useFakeTimers();
    render({ state: 'error', exit: 1 });
    expect(container.querySelectorAll('path[d*="L46 57"]')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(OPS_X_EYES_MS));
    expect(container.querySelectorAll('rect[height="4"][width="7"]')).toHaveLength(2);
    expect(container.querySelector('[data-ops-exit] [data-exit="1"]')).not.toBeNull();
  });

  it('holds one-shot states when told not to settle', () => {
    vi.useFakeTimers();
    render({ state: 'done', settle: false });
    act(() => vi.advanceTimersByTime(OPS_DONE_MS * 2));
    expect(container.querySelector('[data-ops]')?.getAttribute('data-ops')).toBe('done');
  });

  it('sleeps with closed eyes and a "z"', () => {
    const ops = render({ state: 'sleeping' });
    expect(ops?.querySelectorAll('line[x1="39"][y1="55"]')).toHaveLength(1);
    expect(ops?.querySelectorAll('.crew-z').length).toBeGreaterThan(0);
  });

  it('is a static pose at Reduced, with its bubbles', () => {
    motionPreference.set('reduced');
    const ops = render({ state: 'waiting' });
    expect(ops?.hasAttribute('data-crew-paused')).toBe(true);
    expect(ops?.querySelector('circle[r="9"][fill="var(--st-wait)"]')).not.toBeNull();
  });

  it('drops bubbles at Off', () => {
    motionPreference.set('off');
    const ops = render({ state: 'waiting' });
    expect(ops?.hasAttribute('data-crew-paused')).toBe(true);
    expect(ops?.querySelector('circle[r="9"][fill="var(--st-wait)"]')).toBeNull();
  });
});
