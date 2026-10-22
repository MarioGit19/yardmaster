// @vitest-environment happy-dom
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameScheduler } from '../anim/scheduler.js';
import { motionPreference } from '../motion.js';
import { ClaudeOrb, type ClaudeOrbProps } from './ClaudeOrb.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // happy-dom's WAAPI rejects Motion's cancelled animations; the chip only needs to mount.
  MotionGlobalConfig.skipAnimations = true;
  // Everything counts as on screen; frames are requested but never delivered.
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  motionPreference.set('system');
});

function render(props: ClaudeOrbProps) {
  act(() => root.render(<ClaudeOrb {...props} />));
  return container.querySelector<HTMLElement>('[data-orb]');
}

describe('ClaudeOrb', () => {
  it('labels its state for assistive tech and sizes its canvas past the box', () => {
    motionPreference.set('full');
    const orb = render({ state: 'waiting', size: 40 });
    expect(orb?.getAttribute('role')).toBe('img');
    expect(orb?.getAttribute('aria-label')).toBe('Waiting for you');
    expect(orb?.style.width).toBe('40px');
    expect(orb?.querySelector('canvas')?.style.width).toBe('80px');
  });

  it('registers a frame callback only while it has something to animate', () => {
    motionPreference.set('full');
    render({ state: 'working' });
    expect(frameScheduler().activeCount).toBe(1);
    render({ state: 'error' });
    // Entering error plays a glitch first; it is still animating until that ends.
    expect(frameScheduler().activeCount).toBe(1);
    render({ state: 'ended' });
    expect(frameScheduler().activeCount).toBe(0);
    render({ state: 'idle', subagents: 2 });
    expect(frameScheduler().activeCount).toBe(1);
  });

  it('keeps idle orbs off the frame loop and breathes them in CSS', () => {
    motionPreference.set('full');
    const orb = render({ state: 'idle' });
    expect(frameScheduler().activeCount).toBe(0);
    expect(orb?.querySelector('canvas')?.classList.contains('orb-breathe')).toBe(true);
  });

  it('registers no frames at the Reduced level', () => {
    motionPreference.set('reduced');
    render({ state: 'tool', tool: 'Bash', subagents: 2 });
    expect(frameScheduler().activeCount).toBe(0);
  });

  it('shows the tool name chip beside the orb while a tool runs', () => {
    motionPreference.set('full');
    const orb = render({ state: 'tool', tool: 'Grep', subagents: 1 });
    expect(orb?.textContent).toBe('Grep');
    expect(orb?.getAttribute('aria-label')).toBe('Using Grep, 1 subagent');
    act(() => root.unmount());
    root = createRoot(container);
    expect(render({ state: 'tool', tool: 'Grep', showToolLabel: false })?.textContent).toBe('');
  });
});
