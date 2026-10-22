/*
 * Adapted from GlitchText by React Bits (https://reactbits.dev).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0: may be used as part
 * of c-board, but the component must not be sold, sublicensed or redistributed on its own.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changes: the "slices" mode only, played as one short burst when an error arrives instead of a
 * loop (DESIGN.md §3 rule 6; nothing may flash more than 3 times a second); the two offset slices
 * take the rose error color and the Grid neon; WAAPI on transform and opacity (the slice bands are
 * set once per burst); no burst at Reduced or Off, where the title is simply rose.
 */
import { useEffect, useRef } from 'react';
import { useMotionLevel } from '../motion.js';
import { cx } from '../ui/cx.js';

/** One burst: three stepped frames, 60 ms each, then rest. */
const FRAME_MS = 60;
const FRAMES = 3;

export interface GlitchFrame {
  /** Horizontal offsets of the two slices, px. */
  ax: number;
  bx: number;
  /** Slice bands as clip-path insets, percent from the top and from the bottom. */
  a: [number, number];
  b: [number, number];
}

/** A burst's frames: each slice shifts 1.5–3 px left or right inside a random horizontal band. */
export function glitchFrames(random: () => number = Math.random, frames = FRAMES): GlitchFrame[] {
  const sign = () => (random() < 0.5 ? -1 : 1);
  const band = (min: number, span: number): [number, number] => {
    const top = Math.floor(random() * (100 - min - span));
    const height = min + Math.floor(random() * span);
    return [top, Math.max(0, 100 - top - height)];
  };
  return Array.from({ length: frames }, () => ({
    ax: sign() * (1.5 + random() * 1.5),
    bx: sign() * (1.5 + random() * 1.5),
    a: band(18, 30),
    b: band(10, 22),
  }));
}

function play(slice: HTMLElement, frames: GlitchFrame[], key: 'a' | 'b') {
  const [top, bottom] = frames[0]?.[key] ?? [0, 100];
  slice.style.clipPath = `inset(${top}% 0 ${bottom}% 0)`;
  const steps: Keyframe[] = frames.map((frame, i) => ({
    offset: i / frames.length,
    opacity: 1,
    // motion-still: GlitchText only plays at Full.
    transform: `translateX(${key === 'a' ? frame.ax : frame.bx}px)`,
    easing: 'steps(1, end)',
  }));
  // motion-still: GlitchText only plays at Full.
  steps.push({ offset: 1, opacity: 0, transform: 'none' });
  slice
    .animate(steps, { duration: FRAME_MS * frames.length, fill: 'none' })
    .finished.catch(() => {});
}

export interface GlitchTextProps {
  children: string;
  /** Each new value plays one burst (e.g. the error's id or time). Undefined never glitches. */
  burst?: string | number;
  className?: string;
}

/** An error title that glitches once when the error arrives (Grid). The text itself never moves. */
export function GlitchText({ children, burst, className }: GlitchTextProps) {
  const level = useMotionLevel();
  const aRef = useRef<HTMLSpanElement>(null);
  const bRef = useRef<HTMLSpanElement>(null);
  const played = useRef<string | number | undefined>(undefined);

  useEffect(() => {
    const a = aRef.current;
    const b = bRef.current;
    if (burst === undefined || burst === played.current) return;
    played.current = burst;
    if (level !== 'full' || !a || !b || typeof a.animate !== 'function') return;
    // Not cancelled on cleanup: a burst is 180 ms and must survive StrictMode's effect replay.
    const frames = glitchFrames();
    play(a, frames, 'a');
    play(b, frames, 'b');
  }, [burst, level]);

  return (
    <span className={cx('fx-glitch relative inline-block', className)} data-fx="glitch">
      {children}
      <span ref={aRef} aria-hidden className="fx-glitch-slice fx-glitch-a">
        {children}
      </span>
      <span ref={bRef} aria-hidden className="fx-glitch-slice fx-glitch-b">
        {children}
      </span>
    </span>
  );
}
