import { type CSSProperties, type RefObject, useMemo, useRef } from 'react';
import { useInView } from '../../anim/useFrame.js';
import { type RateLoopSpec, useRateLoop } from '../../anim/useRateLoop.js';
import { useMotionLevel } from '../../motion.js';
import { cx } from '../../ui/cx.js';

// The office kit's two output-driven loops (DESIGN.md §10.3): LED rows that blink and screen
// lines that scroll, both faster with the output rate. They are WAAPI on HTML layers (compositor
// opacity and transform) whose playback rate eases toward the rate, so a burst never jumps them.

/** Animates only at Full and while on screen; a still layer costs nothing. */
export function useKitLive(ref: RefObject<Element | null>, enabled = true): boolean {
  const level = useMotionLevel();
  const inView = useInView(ref);
  return enabled && level === 'full' && inView;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Deterministic per-row variety, so rows on one rack never blink in step. */
function blinkSpec(seed: number): RateLoopSpec {
  const r = (i: number) => (((Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453) % 1) + 1) % 1;
  const offsets = [0, 0.18 + r(1) * 0.12, 0.45 + r(2) * 0.1, 0.7 + r(3) * 0.1, 1];
  return {
    keyframes: offsets.map((offset, i) => ({
      offset,
      opacity: i % 2 === 0 ? 1 : 0.25 + r(i + 4) * 0.3,
      easing: 'steps(1, jump-end)',
    })),
    durationMs: 900 + Math.round(r(9) * 500),
  };
}

export interface LedRowProps {
  /** Lights in the row. */
  count: number;
  color: string;
  /** 0..1 output rate: still at 0, blinking up to about 3× faster at 1. */
  rate: number;
  seed: number;
  style?: CSSProperties;
  className?: string;
}

/** A row of status lights over a rack unit, as an HTML layer positioned by `style`. */
export function LedRow({ count, color, rate, seed, style, className }: LedRowProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const busy = clamp01(rate);
  const live = useKitLive(ref, busy > 0.02);
  const spec = useMemo(() => blinkSpec(seed), [seed]);
  useRateLoop(ref, spec, 0.6 + 2.4 * busy, live);
  return (
    <span
      ref={ref}
      aria-hidden
      data-kit-leds
      data-kit-live={live ? '' : undefined}
      className={cx('absolute flex items-center justify-between', className)}
      style={style}
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: lights are positional.
          key={i}
          className="aspect-square h-full rounded-full"
          style={{
            background: color,
            opacity: busy > 0.02 || i === 0 ? 1 : 0.35,
            boxShadow: `0 0 3px ${color}`,
          }}
        />
      ))}
    </span>
  );
}

const SCROLL: RateLoopSpec = {
  // motion-still: the loop only runs at Full (`useKitLive`).
  keyframes: [{ transform: 'translateY(0)' }, { transform: 'translateY(-50%)' }],
  durationMs: 1600,
};

export interface ScrollingLinesProps {
  /** Line lengths in % of the screen width. */
  lines: readonly number[];
  color: string;
  /** 0..1 output rate; the lines crawl at 0 and scroll about 3× faster at 1. */
  rate: number;
  /** False holds them still (a finished screen). */
  running?: boolean;
  style?: CSSProperties;
  className?: string;
}

/** Output lines scrolling inside a screen; positioned by `style`, clipped to its box. */
export function ScrollingLines({
  lines,
  color,
  rate,
  running = true,
  style,
  className,
}: ScrollingLinesProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const live = useKitLive(ref, running);
  useRateLoop(ref, SCROLL, (0.5 + 2.5 * clamp01(rate)) / (lines.length / 4), live);
  // Two copies, so scrolling by half loops seamlessly.
  const rows = [...lines, ...lines];
  const gap = 100 / lines.length;
  return (
    <span aria-hidden className={cx('absolute overflow-hidden', className)} style={style}>
      <span ref={ref} data-kit-scroll className="absolute inset-x-0 top-0 h-[200%]">
        <svg
          aria-hidden
          viewBox={`0 0 100 ${rows.length * gap}`}
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
        >
          {rows.map((w, i) => (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional.
              key={i}
              x="6"
              y={i * gap + gap * 0.35}
              width={w * 0.88}
              height={gap * 0.32}
              rx={gap * 0.16}
              fill={color}
              opacity={i % 3 === 2 ? 0.45 : 0.85}
            />
          ))}
        </svg>
      </span>
    </span>
  );
}
