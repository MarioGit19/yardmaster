import { type RefObject, useEffect, useRef } from 'react';
import { approach } from '../pod/activity.js';
import { type FrameHandle, frameScheduler, type Scheduler } from './scheduler.js';

export interface RateLoopSpec {
  keyframes: Keyframe[];
  /** One cycle at playback rate 1. */
  durationMs: number;
  easing?: string;
  /** e.g. `'::after'`, to drive a pseudo-element's loop. */
  pseudoElement?: string;
}

/** Rate changes ease in over about this long, like the pod border light. */
const RAMP_MS = 500;
const SETTLED = 0.005;

/**
 * An infinite WAAPI loop on `ref`, started once while `enabled`, whose speed follows `rate` by
 * easing `updatePlaybackRate()` toward it. Swapping a CSS `animation-duration` instead would jump
 * the loop to another point of its cycle. Does nothing where `element.animate` is missing.
 */
export function useRateLoop(
  ref: RefObject<Element | null>,
  spec: RateLoopSpec,
  rate: number,
  enabled: boolean,
  scheduler?: Scheduler,
): void {
  const animation = useRef<Animation | null>(null);
  const current = useRef(rate);
  const target = useRef(rate);
  target.current = rate;
  const specRef = useRef(spec);
  specRef.current = spec;

  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof element.animate !== 'function') return;
    const { keyframes, durationMs, easing, pseudoElement } = specRef.current;
    const loop = element.animate(keyframes, {
      duration: durationMs,
      iterations: Number.POSITIVE_INFINITY,
      easing,
      pseudoElement,
    });
    // `cancel()` rejects `finished`; nothing waits on it.
    loop.finished?.catch(() => {});
    // A loop that starts mid-burst starts at that burst's speed.
    current.current = target.current;
    loop.playbackRate = current.current;
    animation.current = loop;
    return () => {
      loop.cancel();
      animation.current = null;
    };
  }, [ref, enabled]);

  useEffect(() => {
    const loop = animation.current;
    if (!enabled || !loop || Math.abs(current.current - rate) < SETTLED) return;
    const handle: FrameHandle = (scheduler ?? frameScheduler()).add((_now, dt) => {
      const next = approach(current.current, rate, dt, RAMP_MS);
      current.current = Math.abs(next - rate) < SETTLED ? rate : next;
      loop.updatePlaybackRate(current.current);
      if (current.current === rate) handle.remove();
    });
    return () => handle.remove();
  }, [rate, enabled, scheduler]);
}
