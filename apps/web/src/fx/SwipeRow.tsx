/*
 * Adapted from SwipeRow by React Bits (https://reactbits.dev).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0: may be used as part
 * of c-board, but the component must not be sold, sublicensed or redistributed on its own.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changes: two directions with one committing action each (swipe right to Allow, left to Deny)
 * instead of a drawer of buttons; actions in status colors with text labels; our springs and
 * motion levels (Reduced and Off settle without travel, the commit fades at Reduced); the row
 * stays a plain container for keyboard and screen-reader users, whose buttons live inside it.
 * Kept: the hysteresis, rubber banding past the edges, flick velocity, haptic tick and the
 * spoken "release to" hint.
 */
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
import { cx } from '../ui/cx.js';

/** Horizontal travel before a press becomes a swipe, px. */
const HYSTERESIS = 10;
/** A release this fast (px/s) toward an action commits it from halfway. */
const FLICK = 700;

export type SwipeTone = 'ok' | 'err' | 'wait' | 'work';

export interface SwipeAction {
  /** Spoken and shown behind the row, e.g. "Allow". */
  label: string;
  tone: SwipeTone;
  icon?: ReactNode;
  onCommit(): void;
}

/** Resistance past the last stop: the row follows less the further it goes (iOS rubber band). */
export const rubber = (overshoot: number, dimension: number, c = 0.55): number =>
  (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));

/** How far the row may travel for a finger offset `dx`, given which actions exist. */
export function swipeOffset(
  dx: number,
  width: number,
  threshold: number,
  sides: { left: boolean; right: boolean },
): number {
  const allowed = dx > 0 ? sides.right : sides.left;
  if (!allowed) return rubber(dx, width, 0.2);
  const reach = Math.abs(dx);
  if (reach <= threshold) return dx;
  return Math.sign(dx) * (threshold + rubber(reach - threshold, width));
}

/** Whether a release at `x` moving at `velocity` (px/s) commits, and to which side. */
export function swipeOutcome(
  x: number,
  velocity: number,
  threshold: number,
  sides: { left: boolean; right: boolean },
): 'left' | 'right' | null {
  const side = x > 0 ? 'right' : x < 0 ? 'left' : null;
  if (!side || !sides[side]) return null;
  const reach = Math.abs(x);
  const flick = Math.sign(velocity) === Math.sign(x) && Math.abs(velocity) >= FLICK;
  return reach >= threshold || (flick && reach >= threshold / 2) ? side : null;
}

interface Grip {
  id: number;
  x0: number;
  y0: number;
  swiping: boolean;
  samples: [number, number][];
}

const TONE_BG: Record<SwipeTone, string> = {
  ok: 'bg-st-ok/15 text-st-ok-ink',
  err: 'bg-st-err/15 text-st-err-ink',
  wait: 'bg-st-wait/15 text-st-wait-ink',
  work: 'bg-st-work/15 text-st-work-ink',
};

export interface SwipeRowProps {
  children: ReactNode;
  /** Revealed and committed by swiping right. */
  right?: SwipeAction;
  /** Revealed and committed by swiping left. */
  left?: SwipeAction;
  disabled?: boolean;
  className?: string;
}

/**
 * A row you can swipe on touch screens to act on it (an approval on a phone: right to Allow, left
 * to Deny). It only adds the gesture: the same actions must stay reachable as buttons inside.
 */
export function SwipeRow({ children, right, left, disabled = false, className }: SwipeRowProps) {
  const level = useMotionLevel();
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useRef(360);
  const grip = useRef<Grip | null>(null);
  const armed = useRef<'left' | 'right' | null>(null);
  const suppressClick = useRef(false);
  const [say, setSay] = useState('');
  const [committed, setCommitted] = useState<'left' | 'right' | null>(null);
  const [dragging, setDragging] = useState(false);
  const x = useMotionValue(0);
  const sides = { left: Boolean(left), right: Boolean(right) };
  const threshold = () => Math.min(width.current * 0.4, 160);

  const rightReveal = useTransform(x, (v) => Math.min(1, Math.max(0, v / threshold())));
  const leftReveal = useTransform(x, (v) => Math.min(1, Math.max(0, -v / threshold())));
  const rightIcon = useTransform(rightReveal, (p) => (p >= 1 ? 1 : 0.85 + 0.1 * p));
  const leftIcon = useTransform(leftReveal, (p) => (p >= 1 ? 1 : 0.85 + 0.1 * p));

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    width.current = element.offsetWidth || width.current;
    const observer = new ResizeObserver(([entry]) => {
      if (entry?.contentRect.width) width.current = entry.contentRect.width;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const settle = (to: number, velocity = 0) => {
    if (level !== 'full') {
      x.set(to);
      return Promise.resolve();
    }
    // Back home on a spring that keeps the finger's velocity; away (a commit) as a quick exit.
    const transition =
      to === 0 ? { ...spring.snappy, velocity } : { duration: dur.base, ease: ease.out, velocity };
    return animate(x, to, transition).finished;
  };

  const arm = (side: 'left' | 'right' | null) => {
    if (side === armed.current) return;
    armed.current = side;
    const action = side === 'right' ? right : side === 'left' ? left : undefined;
    if (!action) return;
    setSay(`Release to ${action.label}`);
    navigator.vibrate?.(8);
  };

  const commit = (side: 'left' | 'right', velocity: number) => {
    const action = side === 'right' ? right : left;
    if (!action) return;
    setCommitted(side);
    setSay(action.label);
    const away = (side === 'right' ? 1 : -1) * (width.current + 24);
    // Reduced keeps the row in place and fades it (below); Off just commits.
    const travel = level === 'full' ? settle(away, velocity) : Promise.resolve();
    void travel.then(() => action.onCommit());
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || committed || grip.current || !event.isPrimary || event.button !== 0) return;
    x.stop();
    suppressClick.current = false;
    grip.current = {
      id: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      swiping: false,
      samples: [],
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = grip.current;
    if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX - g.x0;
    if (!g.swiping) {
      const dy = event.clientY - g.y0;
      if (Math.abs(dx) < HYSTERESIS || Math.abs(dx) < Math.abs(dy)) return;
      g.swiping = true;
      g.x0 += Math.sign(dx) * HYSTERESIS;
      setDragging(true);
      window.getSelection()?.removeAllRanges();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const offset = swipeOffset(event.clientX - g.x0, width.current, threshold(), sides);
    x.set(offset);
    g.samples.push([event.timeStamp, offset]);
    if (g.samples.length > 4) g.samples.shift();
    arm(swipeOutcome(offset, 0, threshold(), sides));
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = grip.current;
    if (!g || g.id !== event.pointerId) return;
    grip.current = null;
    if (!g.swiping) return;
    setDragging(false);
    suppressClick.current = true;
    const [first, last] = [g.samples[0], g.samples.at(-1)];
    const velocity =
      first && last && last[0] > first[0]
        ? ((last[1] - first[1]) / (last[0] - first[0])) * 1000
        : 0;
    const side =
      event.type === 'pointercancel' ? null : swipeOutcome(x.get(), velocity, threshold(), sides);
    armed.current = null;
    if (side) commit(side, velocity);
    else {
      setSay('');
      void settle(0, velocity);
    }
  };

  return (
    <motion.div
      ref={rootRef}
      data-fx="swipe-row"
      data-committed={committed ?? undefined}
      className={cx('relative isolate overflow-hidden rounded-panel', className)}
      animate={{ opacity: committed && level === 'reduced' ? 0 : 1 }}
      transition={{ duration: dur.base }}
    >
      {right && (
        <motion.div
          aria-hidden
          style={{ opacity: rightReveal }}
          className={cx(
            'absolute inset-0 flex items-center gap-2 px-5 font-medium text-body-sm',
            TONE_BG[right.tone],
          )}
        >
          <motion.span style={{ scale: rightIcon }} className="flex items-center gap-2">
            {right.icon}
            {right.label}
          </motion.span>
        </motion.div>
      )}
      {left && (
        <motion.div
          aria-hidden
          style={{ opacity: leftReveal }}
          className={cx(
            'absolute inset-0 flex items-center justify-end gap-2 px-5 font-medium text-body-sm',
            TONE_BG[left.tone],
          )}
        >
          <motion.span style={{ scale: leftIcon }} className="flex items-center gap-2">
            {left.label}
            {left.icon}
          </motion.span>
        </motion.div>
      )}
      <motion.div
        style={{ x }}
        className={cx('relative touch-pan-y', dragging && 'select-none')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={(event) => {
          // The click that ends a swipe must not also press a button inside the row.
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </motion.div>
      <span className="sr-only" aria-live="polite">
        {say}
      </span>
    </motion.div>
  );
}
