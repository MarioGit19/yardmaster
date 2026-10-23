import { useEffect, useRef, useState } from 'react';
import { useFrame, useInView } from '../anim/useFrame.js';
import {
  levelAt,
  useActivityStep,
  useBoardStore,
  useDoneAt,
  useEventCount,
} from '../data/index.js';
import { dur, moment, useMotionLevel } from '../motion.js';
import { approach, borderOpacity, borderSpeed, isFreshDone, SWEEP_MS } from './activity.js';

// The pod's activity layers, DESIGN.md §4.10: a light travelling around the border while the
// project works, a spark on the top hairline per event, and a one-time sweep when a turn ends.

/** Sparks on screen at once; a burst of events doesn't turn into a shower. */
const MAX_SPARKS = 5;
const SPARK_MS = moment.spark * 1000;
/** Where the border light starts, so a fresh pod's light isn't always at the same spot. */
const START_ANGLE = 210;
const CENTER = 'translate(-50%, -50%)';

/** One turn of the light at playback rate 1, so the rate is the speed in units of 36°/s. */
const TURN_MS = 10_000;
const BASE_SPEED = 360 / (TURN_MS / 1000);
/** Smaller changes than these aren't pushed to the compositor or the style. */
const RATE_STEP = 0.01;
const OPACITY_STEP = 0.01;

/**
 * The rotating border light. The spin is a WAAPI rotation on the compositor; while the project
 * is busy and on screen, a frame callback eases its speed and brightness toward the activity
 * level and pushes them only when they change. Reduced and Off show a still light instead.
 */
export function ActivityBorder({ pulseKey, working }: { pulseKey: string; working: number }) {
  const store = useBoardStore();
  const motion = useMotionLevel();
  const step = useActivityStep(pulseKey);
  const active = step > 0 || working > 0;
  const ringRef = useRef<HTMLDivElement>(null);
  const lightRef = useRef<HTMLDivElement>(null);
  const visible = useInView(ringRef);
  const spin = useRef<Animation | null>(null);
  const speed = useRef(0);
  const pushed = useRef({ rate: 0, opacity: -1 });
  const spinning = active && motion === 'full';

  useEffect(() => {
    const light = lightRef.current;
    if (!spinning || !light || typeof light.animate !== 'function') return;
    const loop = light.animate(
      // motion-still: the spin only runs at Full; Reduced and Off render the still light.
      [{ transform: `${CENTER} rotate(0deg)` }, { transform: `${CENTER} rotate(360deg)` }],
      { duration: TURN_MS, iterations: Number.POSITIVE_INFINITY },
    );
    loop.finished?.catch(() => {});
    loop.currentTime = (START_ANGLE / 360) * TURN_MS;
    loop.playbackRate = 0;
    pushed.current = { rate: 0, opacity: -1 };
    spin.current = loop;
    return () => {
      // The still light stays where the spin left it.
      const at = Number(loop.currentTime ?? 0) % TURN_MS;
      light.style.transform = `${CENTER} rotate(${(at / TURN_MS) * 360}deg)`;
      loop.cancel();
      spin.current = null;
    };
  }, [spinning]);

  useFrame(
    (_now, dt) => {
      const level = levelAt(store.getState().pulses[pulseKey], Date.now());
      speed.current = approach(speed.current, borderSpeed(level, working), dt);
      const rate = speed.current / BASE_SPEED;
      const opacity = borderOpacity(Math.max(level, working > 0 ? 0.3 : 0));
      const last = pushed.current;
      const loop = spin.current;
      if (loop && Math.abs(rate - last.rate) >= RATE_STEP * Math.max(1, last.rate)) {
        loop.updatePlaybackRate(rate);
        last.rate = rate;
      }
      const ring = ringRef.current;
      if (ring && Math.abs(opacity - last.opacity) >= OPACITY_STEP) {
        ring.style.opacity = opacity.toFixed(3);
        last.opacity = opacity;
      }
    },
    { visible, enabled: spinning },
  );

  useEffect(() => {
    // Off screen the light holds still; back on screen it eases up to speed again.
    if (!visible && spin.current) {
      spin.current.updatePlaybackRate(0);
      pushed.current.rate = 0;
      speed.current = 0;
    }
  }, [visible]);

  useEffect(() => {
    const ring = ringRef.current;
    if (!spinning) {
      // Leaving the spin (quiet, or the motion level changed) hands opacity back to CSS, which
      // fades it out.
      speed.current = 0;
      if (ring) {
        delete ring.dataset.driven;
        ring.style.opacity = '';
      }
      return;
    }
    if (!ring) return;
    // The CSS fade carries the ring in; after it the frame loop owns opacity, and a transition
    // would restart on every write.
    const handOff = window.setTimeout(() => {
      ring.dataset.driven = '';
    }, dur.slow * 1000);
    return () => window.clearTimeout(handOff);
  }, [spinning]);

  return (
    <div
      ref={ringRef}
      aria-hidden
      data-activity-border={active ? (spinning ? 'spin' : 'still') : undefined}
      className="pod-ring"
    >
      <div
        ref={lightRef}
        className="pod-ring-light"
        style={{ transform: `${CENTER} rotate(${START_ANGLE}deg)` }}
      />
    </div>
  );
}

interface Spark {
  id: number;
  x: number;
}

/** A tiny particle on the top hairline for each new event. None at Reduced or Off. */
export function EventSparks({ pulseKey }: { pulseKey: string }) {
  const motion = useMotionLevel();
  const events = useEventCount(pulseKey);
  const seen = useRef(events);
  const [sparks, setSparks] = useState<Spark[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const fresh = events - seen.current;
    seen.current = events;
    if (fresh <= 0 || motion !== 'full') return;
    const added = Array.from({ length: Math.min(fresh, MAX_SPARKS) }, () => ({
      id: Math.random(),
      // Inside the hairline, which stops 16 px short of each corner.
      x: 8 + Math.random() * 84,
    }));
    setSparks((current) => [...current, ...added].slice(-MAX_SPARKS));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setSparks((current) => current.filter((s) => !added.includes(s)));
    }, SPARK_MS);
    timers.current.add(timer);
  }, [events, motion]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  if (sparks.length === 0) return null;
  return (
    <div aria-hidden className="pod-sparks">
      {sparks.map((spark) => (
        <span key={spark.id} className="pod-spark" style={{ left: `${spark.x}%` }} />
      ))}
    </div>
  );
}

/**
 * A gentle green sweep across the pod when a turn finishes, played once per turn (§3 rule 5).
 * Reduced fades a green wash in and out instead; Off shows nothing. Calls `onPlay` per sweep.
 */
export function DoneSweep({ pulseKey, onPlay }: { pulseKey: string; onPlay?: () => void }) {
  const motion = useMotionLevel();
  const doneAt = useDoneAt(pulseKey);
  // Turns that finished before the pod mounted are history.
  const seen = useRef(doneAt);
  const [playing, setPlaying] = useState<number | null>(null);
  const play = useRef(onPlay);
  play.current = onPlay;

  useEffect(() => {
    if (motion === 'off' || !isFreshDone(doneAt, seen.current, Date.now())) {
      seen.current = doneAt;
      return;
    }
    seen.current = doneAt;
    setPlaying(doneAt);
    play.current?.();
  }, [doneAt, motion]);

  useEffect(() => {
    if (playing === null) return;
    // A timer, not animationend: the sweep must clear even when the tab is in the background.
    const timer = setTimeout(() => setPlaying(null), SWEEP_MS + 100);
    return () => clearTimeout(timer);
  }, [playing]);

  if (playing === null) return null;
  return (
    <div aria-hidden data-done-sweep className="pod-sweep">
      <div key={playing} className="pod-sweep-band" />
    </div>
  );
}
