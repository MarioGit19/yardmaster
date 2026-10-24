/*
 * Adapted from DecryptedText by React Bits (https://reactbits.dev).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0: may be used as part
 * of Yardmaster, but the component must not be sold, sublicensed or redistributed on its own.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changes: one trigger (the text changed), one reveal (sequential from the start) and one look
 * (the unresolved tail in a dim scramble); the frame writes two text nodes directly instead of
 * re-rendering per character; runs on the shared rAF loop, finishes at once off screen, and
 * Reduced and Off just show the new text.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useFrame, useInView } from '../anim/useFrame.js';
import { dur, useMotionLevel } from '../motion.js';

/** Glyphs the unresolved tail cycles through (ASCII, so the mono width holds). */
export const SCRAMBLE_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+<>/\\=?';

/**
 * The visible text `step` frames into a resolve: the first `revealed` characters are final and
 * the rest scramble (whitespace stays whitespace, so words keep their shape).
 */
export function decryptFrame(
  text: string,
  revealed: number,
  random: () => number = Math.random,
): { done: string; tail: string } {
  const chars = Array.from(text);
  const done = chars.slice(0, revealed).join('');
  const tail = chars
    .slice(revealed)
    .map((char) =>
      /\s/.test(char)
        ? char
        : (SCRAMBLE_GLYPHS[Math.floor(random() * SCRAMBLE_GLYPHS.length)] ?? char),
    )
    .join('');
  return { done, tail };
}

export interface DecryptedTextProps {
  text: string;
  className?: string;
  /** The unresolved tail's look; dim by default. */
  scrambleClassName?: string;
  /** Resolve on first render too, not only when the text changes. */
  resolveOnMount?: boolean;
  /** Total time to resolve, whatever the length (seconds). */
  duration?: number;
}

/**
 * Text that resolves out of a scramble when it changes: a caption in the Grid cockpit or the
 * Retro console. Screen readers get the final text at once.
 */
export function DecryptedText({
  text,
  className,
  scrambleClassName = 'text-text-3',
  resolveOnMount = false,
  duration = dur.slow,
}: DecryptedTextProps) {
  const level = useMotionLevel();
  const rootRef = useRef<HTMLSpanElement>(null);
  const doneRef = useRef<HTMLSpanElement>(null);
  const tailRef = useRef<HTMLSpanElement>(null);
  const visible = useInView(rootRef);
  const run = useRef<{ text: string; elapsed: number; tick: number } | null>(null);
  const first = useRef(true);
  // The frame callback is registered only while a resolve runs.
  const [running, setRunning] = useState(false);

  const paint = useCallback((done: string, tail: string) => {
    if (doneRef.current) doneRef.current.textContent = done;
    if (tailRef.current) tailRef.current.textContent = tail;
  }, []);

  useLayoutEffect(() => {
    const mounting = first.current;
    first.current = false;
    if (level !== 'full' || (mounting && !resolveOnMount)) {
      run.current = null;
      paint(text, '');
      setRunning(false);
      return;
    }
    run.current = { text, elapsed: 0, tick: -1 };
    const frame = decryptFrame(text, 0);
    paint(frame.done, frame.tail);
    setRunning(true);
  }, [text, level, resolveOnMount, paint]);

  useFrame(
    (_now, dt) => {
      const current = run.current;
      if (!current) return;
      current.elapsed += dt;
      const length = Array.from(current.text).length;
      const progress = Math.min(1, current.elapsed / (duration * 1000));
      // The scramble changes about every 40 ms, not every frame, so it reads as text.
      const tick = Math.floor(current.elapsed / 40);
      if (progress >= 1 || !visible) {
        run.current = null;
        paint(current.text, '');
        setRunning(false);
        return;
      }
      if (tick === current.tick) return;
      current.tick = tick;
      const frame = decryptFrame(current.text, Math.floor(progress * length));
      paint(frame.done, frame.tail);
    },
    { enabled: running },
  );

  return (
    <span ref={rootRef} className={className} data-fx="decrypted">
      <span className="sr-only">{text}</span>
      {/* Filled by `paint` (before the browser paints), never by React, so the two never fight. */}
      <span aria-hidden>
        <span ref={doneRef} />
        <span ref={tailRef} className={scrambleClassName} />
      </span>
    </span>
  );
}
