import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';
import { useFrame, useInView } from '../anim/useFrame.js';
import { dur, useMotionLevel } from '../motion.js';

/** One character every this many ms, unless that would take longer than `dur.slow` in all. */
export const TYPE_MS_PER_CHAR = 28;

/** How many characters of a `length`-character text are typed `elapsed` ms in. */
export function typedCount(length: number, elapsed: number): number {
  const total = Math.min(length * TYPE_MS_PER_CHAR, dur.slow * 1000);
  if (total <= 0 || elapsed >= total) return length;
  return Math.floor((elapsed / total) * length);
}

/**
 * A Retro caption typed out character by character when it changes (DESIGN.md §10.6). The text
 * on screen at mount is already there; Reduced and Off show a new text at once, and so does a
 * caption off screen. The frame writes the text node directly instead of re-rendering per
 * character.
 */
export function TypedText({
  text,
  title = text,
  className,
  style,
}: {
  text: string;
  /** The tooltip, when `text` is a clipped version of something longer. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const level = useMotionLevel();
  const ref = useRef<HTMLSpanElement>(null);
  const visible = useInView(ref);
  const run = useRef<{ chars: string[]; elapsed: number; shown: number } | null>(null);
  const first = useRef(true);
  const [running, setRunning] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    const mounting = first.current;
    first.current = false;
    if (!element) return;
    if (mounting || level !== 'full') {
      run.current = null;
      element.textContent = text;
      setRunning(false);
      return;
    }
    run.current = { chars: Array.from(text), elapsed: 0, shown: 0 };
    element.textContent = '';
    setRunning(true);
  }, [text, level]);

  useFrame(
    (_now, dt) => {
      const current = run.current;
      const element = ref.current;
      if (!current || !element) return;
      current.elapsed += dt;
      const shown = visible ? typedCount(current.chars.length, current.elapsed) : Infinity;
      if (shown >= current.chars.length) {
        element.textContent = current.chars.join('');
        run.current = null;
        setRunning(false);
        return;
      }
      if (shown === current.shown) return;
      current.shown = shown;
      element.textContent = current.chars.slice(0, shown).join('');
    },
    { enabled: running },
  );

  return (
    <span
      ref={ref}
      title={title}
      data-typed={running || undefined}
      className={className}
      style={style}
    />
  );
}
