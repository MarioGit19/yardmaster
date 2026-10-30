/*
 * Adapted from HoldButton by React Bits (https://reactbits.dev).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0: may be used as part
 * of Yardmaster, but the component must not be sold, sublicensed or redistributed on its own.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changes: the fill is a status-tinted layer scaled on the compositor (WAAPI `scaleX`, not an
 * animated clip-path), with no wave crest, glow pulse or press scale; the label never changes
 * color, so it needs no clipped copy; Reduced fades the fill in instead of growing it, Off shows a
 * static holding state; tokens for size, radius and timing. Kept: pointer capture, drifting off
 * the button cancels, Space/Enter hold for keyboards, Esc, blur and a hidden tab cancel.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { dur, ease, useMotionLevel } from '../motion.js';
import { countOf } from '../plural.js';
import { cx } from '../ui/cx.js';

/** How far the pointer may drift off the button before the hold cancels, px. */
const DRIFT = 12;
const RELEASE_MS = dur.base * 1000;
const EASE_OUT = `cubic-bezier(${ease.out.join(', ')})`;

type Phase = 'idle' | 'holding' | 'done';

const TONE: Record<'err' | 'wait', { fill: string; bar: string; ring: string }> = {
  err: { fill: 'bg-st-err/20', bar: 'bg-st-err', ring: 'focus-visible:outline-st-err' },
  wait: { fill: 'bg-st-wait/20', bar: 'bg-st-wait', ring: 'focus-visible:outline-st-wait' },
};

export interface HoldButtonProps {
  /** The resting label, e.g. "Hold to stop". */
  children: ReactNode;
  /** Shown once the hold completes. */
  doneLabel?: ReactNode;
  icon?: ReactNode;
  tone?: 'err' | 'wait';
  /** How long to hold, ms. */
  holdMs?: number;
  /** When the button returns to rest after completing, ms; 0 keeps it done. */
  resetAfter?: number;
  disabled?: boolean;
  onHold(): void;
  className?: string;
}

/**
 * A destructive action that needs a deliberate press and hold (kill a terminal, interrupt Claude
 * on a phone). Pointer, touch and keyboard (hold Space or Enter) all work.
 */
export function HoldButton({
  children,
  doneLabel,
  icon,
  tone = 'err',
  holdMs = 1200,
  resetAfter = 1600,
  disabled = false,
  onHold,
  className,
}: HoldButtonProps) {
  const level = useMotionLevel();
  const hintId = useId();
  const [phase, setPhase] = useState<Phase>('idle');
  const [input, setInput] = useState<'pointer' | 'key' | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const pointer = useRef<{ id: number; rect: DOMRect } | null>(null);
  const viaKey = useRef(false);
  const timers = useRef({ complete: 0, reset: 0 });
  /** Progress 0..1 at `since` and whether it is rising; the fill animation follows the same line. */
  const progress = useRef({ from: 0, since: 0, rising: false });
  const animation = useRef<Animation | null>(null);
  const onHoldRef = useRef(onHold);
  onHoldRef.current = onHold;

  const go = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const current = () => {
    const p = progress.current;
    if (!p.rising) return p.from;
    return Math.min(1, p.from + (performance.now() - p.since) / holdMs);
  };

  /** Drives the fill from where it is to `to` (1 over the rest of the hold, 0 on release). */
  const drive = (to: 0 | 1) => {
    const from = current();
    progress.current = { from, since: performance.now(), rising: to === 1 };
    const fill = fillRef.current;
    animation.current?.cancel();
    animation.current = null;
    if (!fill || typeof fill.animate !== 'function' || level === 'off') return;
    const duration = to === 1 ? holdMs * (1 - from) : RELEASE_MS * from;
    const frames: Keyframe[] =
      level === 'full'
        ? // motion-still: Reduced takes the opacity branch below.
          [{ transform: `scaleX(${from})` }, { transform: `scaleX(${to})` }]
        : [{ opacity: from }, { opacity: to }];
    animation.current = fill.animate(frames, {
      duration: Math.max(1, duration),
      easing: to === 1 ? 'linear' : EASE_OUT,
      fill: 'forwards',
    });
    animation.current.finished.catch(() => {});
  };

  const clearTimers = () => {
    clearTimeout(timers.current.complete);
    clearTimeout(timers.current.reset);
  };

  const begin = (byKey: boolean) => {
    if (disabled || phaseRef.current !== 'idle') return false;
    viaKey.current = byKey;
    setInput(byKey ? 'key' : 'pointer');
    go('holding');
    const remaining = holdMs * (1 - current());
    drive(1);
    timers.current.complete = window.setTimeout(() => {
      if (phaseRef.current !== 'holding') return;
      go('done');
      onHoldRef.current();
      if (resetAfter > 0) {
        timers.current.reset = window.setTimeout(() => {
          go('idle');
          drive(0);
        }, resetAfter);
      }
    }, remaining);
    return true;
  };

  const release = () => {
    if (phaseRef.current !== 'holding') return;
    clearTimers();
    go('idle');
    drive(0);
  };
  const releaseRef = useRef(release);
  releaseRef.current = release;

  useEffect(() => {
    if (phase !== 'holding') return;
    const cancel = () => releaseRef.current();
    const onVisibility = () => document.hidden && cancel();
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [phase]);

  useEffect(
    () => () => {
      clearTimeout(timers.current.complete);
      clearTimeout(timers.current.reset);
      animation.current?.cancel();
    },
    [],
  );

  const seconds = Math.round(holdMs / 100) / 10;
  const colors = TONE[tone];
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      data-fx="hold-button"
      data-phase={phase}
      data-input={input ?? undefined}
      aria-describedby={hintId}
      className={cx(
        'relative isolate inline-grid min-h-11 touch-manipulation select-none place-items-center overflow-hidden rounded-control border border-line bg-bg-2 px-5 font-medium text-body-sm text-text-1 [-webkit-touch-callout:none] hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-50',
        colors.ring,
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary || pointer.current) return;
        if (!begin(false)) return;
        pointer.current = {
          id: event.pointerId,
          rect: event.currentTarget.getBoundingClientRect(),
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const held = pointer.current;
        if (!held || held.id !== event.pointerId) return;
        const { rect } = held;
        const outside =
          event.clientX < rect.left - DRIFT ||
          event.clientX > rect.right + DRIFT ||
          event.clientY < rect.top - DRIFT ||
          event.clientY > rect.bottom + DRIFT;
        if (outside) {
          pointer.current = null;
          release();
        }
      }}
      onPointerUp={(event) => {
        if (pointer.current?.id !== event.pointerId) return;
        pointer.current = null;
        release();
      }}
      onPointerCancel={() => {
        pointer.current = null;
        release();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && viaKey.current) release();
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        if (!event.repeat) begin(true);
      }}
      onKeyUp={(event) => {
        if ((event.key === ' ' || event.key === 'Enter') && viaKey.current) {
          event.preventDefault();
          release();
        }
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span
        ref={fillRef}
        aria-hidden
        className={cx('fx-hold-fill pointer-events-none absolute inset-0 -z-10', colors.fill)}
      >
        <span className={cx('absolute inset-x-0 bottom-0 h-0.5', colors.bar)} />
      </span>
      <span className="fx-hold-label col-start-1 row-start-1 flex items-center gap-2">
        {icon}
        {children}
      </span>
      <span
        aria-hidden={phase !== 'done'}
        className="fx-hold-done col-start-1 row-start-1 flex items-center gap-2"
      >
        {doneLabel}
      </span>
      <span id={hintId} className="sr-only">
        Press and hold for {countOf(seconds, 'second')} to confirm
      </span>
    </button>
  );
}
