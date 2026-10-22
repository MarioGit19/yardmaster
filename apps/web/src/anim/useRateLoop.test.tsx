// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduler, type Scheduler } from './scheduler.js';
import { type RateLoopSpec, useRateLoop } from './useRateLoop.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let scheduler: Scheduler;
const pending: ((now: number) => void)[] = [];

const SPEC: RateLoopSpec = { keyframes: [{ opacity: 0 }, { opacity: 1 }], durationMs: 1000 };

function fakeAnimation() {
  return {
    playbackRate: 1,
    finished: Promise.resolve(),
    updatePlaybackRate: vi.fn(function (this: { playbackRate: number }, rate: number) {
      this.playbackRate = rate;
    }),
    cancel: vi.fn(),
  };
}

let animation: ReturnType<typeof fakeAnimation>;
let element: { animate: ReturnType<typeof vi.fn> };
let ref: { current: Element | null };

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
  animation = fakeAnimation();
  element = { animate: vi.fn(() => animation) };
  ref = { current: element as unknown as Element };
});

afterEach(() => act(() => root.unmount()));

function Probe({ rate, enabled }: { rate: number; enabled: boolean }) {
  useRateLoop(ref, SPEC, rate, enabled, scheduler);
  return null;
}

const render = (rate: number, enabled = true) =>
  act(() => root.render(<Probe rate={rate} enabled={enabled} />));

/** Runs frames 16 ms apart until the scheduler goes quiet. */
function runFrames(max = 500): number {
  let now = 0;
  let frames = 0;
  while (pending.length > 0 && frames < max) {
    now += 16;
    frames += 1;
    pending.shift()?.(now);
  }
  return frames;
}

describe('useRateLoop', () => {
  it('starts one infinite loop at the current rate and cancels it when disabled', () => {
    render(1.5, false);
    expect(element.animate).not.toHaveBeenCalled();
    render(1.5);
    expect(element.animate).toHaveBeenCalledTimes(1);
    expect(element.animate.mock.calls[0]?.[1]).toMatchObject({
      duration: 1000,
      iterations: Number.POSITIVE_INFINITY,
    });
    expect(animation.playbackRate).toBe(1.5);
    render(1.5, false);
    expect(animation.cancel).toHaveBeenCalled();
  });

  it('eases the playback rate toward a new speed instead of restarting the loop', () => {
    render(1);
    render(2.4);
    expect(element.animate).toHaveBeenCalledTimes(1);
    pending.shift()?.(16);
    pending.shift()?.(32);
    const early = animation.playbackRate;
    expect(early).toBeGreaterThan(1);
    expect(early).toBeLessThan(2.4);
    const frames = runFrames();
    expect(animation.playbackRate).toBe(2.4);
    // It settles and stops asking for frames.
    expect(frames).toBeLessThan(500);
    expect(scheduler.size).toBe(0);
    const rates = animation.updatePlaybackRate.mock.calls.map(([rate]) => rate as number);
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
  });
});
