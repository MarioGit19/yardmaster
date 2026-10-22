// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduler, type Scheduler } from './scheduler.js';
import { useFrame } from './useFrame.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let scheduler: Scheduler;
const pending: ((now: number) => void)[] = [];

beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
  pending.length = 0;
  scheduler = createScheduler({
    request: (callback) => pending.push(callback),
    cancel: () => {
      pending.length = 0;
    },
  });
});

afterEach(() => act(() => root.unmount()));

function Probe(props: { onFrame(now: number): void; visible: boolean; enabled: boolean }) {
  useFrame(props.onFrame, { visible: props.visible, enabled: props.enabled, scheduler });
  return null;
}

describe('useFrame', () => {
  it('registers only while visible and enabled, and unregisters on unmount', () => {
    const onFrame = vi.fn();
    const render = (visible: boolean, enabled: boolean) =>
      act(() => root.render(<Probe onFrame={onFrame} visible={visible} enabled={enabled} />));

    render(false, true);
    expect(scheduler.size).toBe(0);
    render(true, false);
    expect(scheduler.size).toBe(0);
    render(true, true);
    expect(scheduler.size).toBe(1);

    pending.shift()?.(16);
    expect(onFrame).toHaveBeenCalledWith(16, 0);

    render(false, true);
    expect(scheduler.size).toBe(0);
    render(true, true);
    act(() => root.unmount());
    expect(scheduler.size).toBe(0);
    root = createRoot(container);
  });

  it('always calls the latest callback without re-registering', () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() => root.render(<Probe onFrame={first} visible enabled />));
    const add = vi.spyOn(scheduler, 'add');
    act(() => root.render(<Probe onFrame={second} visible enabled />));
    expect(add).not.toHaveBeenCalled();
    pending.shift()?.(16);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });
});
