/*
 * Adapted from SplitFlapText by React Bits (https://reactbits.dev).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0: may be used as part
 * of c-board, but the component must not be sold, sublicensed or redistributed on its own.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changes: one phrase that flips when it changes (no word cycling, intro or glare); tiles on our
 * surfaces and in Geist Mono, in the caller's (status) color; each flap is a `dur.fast` leaf pair
 * animated on transform and filter only; steps run on the shared rAF loop and only while a change
 * is in flight; Reduced and Off swap the text without flipping.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { useFrame, useInView } from '../anim/useFrame.js';
import { dur, useMotionLevel } from '../motion.js';
import { cx } from '../ui/cx.js';

const DEFAULT_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** Delay between neighbouring tiles starting, ms. */
const STAGGER_MS = 30;

interface Tile {
  current: string;
  next: string;
  /** Bumped per flip so the leaves remount and their CSS animation restarts. */
  tick: number;
}

interface Plan {
  index: number;
  sequence: string[];
  start: number;
  step: number;
}

/** `text` fitted to `width` cells (cut or padded with spaces), upper-cased like a station board. */
export function boardText(text: string, width: number): string {
  return Array.from(text.toUpperCase()).slice(0, width).join('').padEnd(width, ' ');
}

/** The flips a tile goes through from `from` to `to`: `flips` random glyphs, then the target. */
export function flipSequence(
  to: string,
  flips: number,
  charset: string,
  random: () => number = Math.random,
): string[] {
  const steps: string[] = [];
  for (let i = 0; i < flips; i++) steps.push(charset[Math.floor(random() * charset.length)] ?? to);
  steps.push(to);
  return steps;
}

const rest = (text: string): Tile[] =>
  Array.from(text).map((char) => ({ current: char, next: char, tick: 0 }));

export interface SplitFlapTextProps {
  text: string;
  /** Number of tiles; longer text is cut, shorter is padded. Defaults to the text's length. */
  width?: number;
  /** Random glyphs each changed tile shows before it lands. */
  flips?: number;
  charset?: string;
  className?: string;
}

/** A station-board line whose tiles flip to the new text (Transit and Retro status changes). */
export function SplitFlapText({
  text,
  width,
  flips = 3,
  charset = DEFAULT_CHARSET,
  className,
}: SplitFlapTextProps) {
  const level = useMotionLevel();
  const target = boardText(text, width ?? Array.from(text).length);
  const [tiles, setTiles] = useState<Tile[]>(() => rest(target));
  const shown = useRef(target);
  const plans = useRef<Plan[]>([]);
  const elapsed = useRef(0);
  const [running, setRunning] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const visible = useInView(rootRef);
  const flipMs = dur.fast * 1000;

  useLayoutEffect(() => {
    const from = shown.current;
    shown.current = target;
    if (from === target) return;
    if (level !== 'full' || from.length !== target.length) {
      plans.current = [];
      setRunning(false);
      setTiles(rest(target));
      return;
    }
    const fromChars = Array.from(from);
    const toChars = Array.from(target);
    plans.current = toChars.flatMap((char, index) =>
      fromChars[index] === char
        ? []
        : [
            {
              index,
              sequence: flipSequence(char, flips, charset),
              start: index * STAGGER_MS,
              step: -1,
            },
          ],
    );
    elapsed.current = 0;
    setTiles((tiles) =>
      tiles.map((tile, i) => ({ ...tile, current: fromChars[i] ?? tile.current })),
    );
    setRunning(true);
  }, [target, level, flips, charset]);

  useFrame(
    (_now, dt) => {
      elapsed.current += dt;
      const updates = new Map<number, number>();
      let busy = false;
      for (const plan of plans.current) {
        const local = elapsed.current - plan.start;
        const step = visible ? Math.floor(local / flipMs) : plan.sequence.length;
        if (local < 0 && visible) {
          busy = true;
          continue;
        }
        if (step < plan.sequence.length) busy = true;
        const at = Math.min(step, plan.sequence.length);
        if (at !== plan.step) {
          plan.step = at;
          updates.set(plan.index, at);
        }
      }
      if (updates.size > 0) {
        setTiles((tiles) =>
          tiles.map((tile, i) => {
            const plan = plans.current.find((p) => p.index === i);
            const step = updates.get(i);
            if (!plan || step === undefined) return tile;
            const landed = plan.sequence[plan.sequence.length - 1] ?? tile.next;
            if (step >= plan.sequence.length)
              return { current: landed, next: landed, tick: tile.tick };
            return {
              current: step === 0 ? tile.current : (plan.sequence[step - 1] ?? tile.current),
              next: plan.sequence[step] ?? landed,
              tick: tile.tick + 1,
            };
          }),
        );
      }
      if (!busy) {
        plans.current = [];
        setRunning(false);
      }
    },
    { enabled: running },
  );

  return (
    <span ref={rootRef} className={cx('fx-flap', className)} data-fx="split-flap">
      <span className="sr-only">{text}</span>
      <span aria-hidden className="inline-flex gap-[0.12em]">
        {tiles.map((tile, i) => {
          const flipping = tile.current !== tile.next;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: tiles are fixed board positions.
            <span key={i} className="fx-flap-tile" data-flipping={flipping || undefined}>
              <span className="fx-flap-half fx-flap-top">
                <span className="fx-flap-char">{tile.next}</span>
              </span>
              <span className="fx-flap-half fx-flap-bottom">
                <span className="fx-flap-char">{tile.current}</span>
              </span>
              {flipping && (
                <>
                  <span key={`f${tile.tick}`} className="fx-flap-leaf fx-flap-front">
                    <span className="fx-flap-char">{tile.current}</span>
                  </span>
                  <span key={`b${tile.tick}`} className="fx-flap-leaf fx-flap-back">
                    <span className="fx-flap-char">{tile.next}</span>
                  </span>
                </>
              )}
            </span>
          );
        })}
      </span>
    </span>
  );
}
