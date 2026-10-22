// @vitest-environment happy-dom
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { motionPreference } from '../motion.js';
import { CrewMascot, type CrewMascotProps } from './CrewMascot.js';
import { DONE_MS, ERROR_X_EYES_MS } from './model.js';

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
  // Everything counts as on screen unless a test says otherwise.
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

function render(props: CrewMascotProps) {
  act(() => root.render(<CrewMascot {...props} />));
  return container.querySelector<HTMLElement>('[data-crew]');
}

const eyes = () => container.querySelectorAll('[data-crew] circle[r="3.4"]').length;
const crossEyes = () => container.querySelectorAll('[data-crew] path[d*="L46 58"]').length;

describe('CrewMascot', () => {
  it('labels its state and sizes itself', () => {
    const crew = render({ state: 'typing', tool: 'Edit', size: 56 });
    expect(crew?.getAttribute('role')).toBe('img');
    expect(crew?.getAttribute('aria-label')).toBe('Typing (Edit)');
    expect(crew?.style.width).toBe('56px');
    expect(crew?.dataset.crewDetail).toBe('acting');
    // The antenna tip is a ClaudeOrb in the matching state.
    expect(crew?.querySelector('[data-orb]')?.getAttribute('data-orb')).toBe('tool');
  });

  it('shows props at 56 px and only posture at 24 px', () => {
    let crew = render({ state: 'waiting', size: 56 });
    expect(crew?.querySelector('[fill="var(--st-wait)"]')).not.toBeNull();
    crew = render({ state: 'waiting', size: 24 });
    expect(crew?.dataset.crewDetail).toBe('posture');
    expect(crew?.querySelector('[fill="var(--st-wait)"]')).toBeNull();
  });

  it('adds detail at 120 px', () => {
    const crew = render({ state: 'typing', size: 120 });
    expect(crew?.dataset.crewDetail).toBe('detailed');
    // Individual keys on the keyboard.
    expect(crew?.querySelectorAll('rect[height="2.5"]').length).toBeGreaterThan(5);
  });

  it('closes its eyes while asleep', () => {
    render({ state: 'sleeping' });
    expect(eyes()).toBe(0);
    expect(container.querySelectorAll('line[x1="39.5"]').length).toBe(1);
    render({ state: 'idle' });
    expect(eyes()).toBe(2);
  });

  it('settles done into idle once', () => {
    vi.useFakeTimers();
    const crew = render({ state: 'done' });
    expect(crew?.dataset.crew).toBe('done');
    act(() => vi.advanceTimersByTime(DONE_MS));
    expect(container.querySelector('[data-crew]')?.getAttribute('data-crew')).toBe('idle');
  });

  it('shows ×-eyes on error, then a worried look', () => {
    vi.useFakeTimers();
    render({ state: 'error' });
    expect(crossEyes()).toBe(1);
    act(() => vi.advanceTimersByTime(ERROR_X_EYES_MS));
    expect(container.querySelectorAll('ellipse[ry="2.4"]').length).toBe(2);
  });

  it('holds one-shot states when told not to settle', () => {
    vi.useFakeTimers();
    render({ state: 'done', settle: false });
    act(() => vi.advanceTimersByTime(DONE_MS * 2));
    expect(container.querySelector('[data-crew]')?.getAttribute('data-crew')).toBe('done');
  });

  it('pops out mini crew members for subagents', () => {
    let crew = render({ state: 'delegating', size: 56 });
    expect(crew?.getAttribute('aria-label')).toBe('Delegating to a subagent, 1 subagent');
    expect(crew?.querySelectorAll('[fill="var(--orb-task)"]').length).toBe(1);
    crew = render({ state: 'thinking', size: 56, subagents: 5 });
    expect(crew?.querySelectorAll('[fill="var(--orb-task)"]').length).toBe(3);
  });

  it('is a static pose at Reduced, with its bubbles', () => {
    motionPreference.set('reduced');
    const crew = render({ state: 'thinking' });
    expect(crew?.hasAttribute('data-crew-paused')).toBe(true);
    expect(crew?.querySelectorAll('.crew-dot').length).toBe(3);
  });

  it('drops bubbles at Off', () => {
    motionPreference.set('off');
    const crew = render({ state: 'thinking' });
    expect(crew?.hasAttribute('data-crew-paused')).toBe(true);
    expect(crew?.querySelectorAll('.crew-dot').length).toBe(0);
  });

  it('runs its loops on screen and pauses them off screen', () => {
    let notify: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | null = null;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: typeof notify) {
          notify = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const crew = render({ state: 'idle' });
    expect(crew?.hasAttribute('data-crew-paused')).toBe(true);
    act(() => notify?.([{ target: crew as Element, isIntersecting: true }]));
    expect(crew?.hasAttribute('data-crew-paused')).toBe(false);
    act(() => notify?.([{ target: crew as Element, isIntersecting: false }]));
    expect(crew?.hasAttribute('data-crew-paused')).toBe(true);
  });
});
