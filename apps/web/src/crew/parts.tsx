import { animate, motion, type Transition } from 'motion/react';
import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useInView } from '../anim/useFrame.js';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
import { cx } from '../ui/cx.js';
import { useCrewCrowd } from './crowd.js';
import { BLINK_EVERY_MS, between, LOOK_AROUND_EVERY_MS } from './model.js';

// The parts the crew mascot and its ops sibling share (DESIGN.md §4.11, §10.3): HTML layers
// over a 0–100 viewBox, prop entrances, and the per-instance idle variety.

export type Point = { x: number; y: number };

/** HTML parts of a prop enter and leave like `Prop`. */
export const PROP_LAYER = {
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1, transition: spring.snappy },
  exit: { opacity: 0, scale: 0.9, transition: { duration: dur.fast, ease: ease.out } },
};

/** Places an HTML layer over a viewBox rectangle (the mascot's box is square). */
export const box = (x: number, y: number, width: number, height: number): CSSProperties => ({
  left: `${x}%`,
  top: `${y}%`,
  width: `${width}%`,
  height: `${height}%`,
});

/**
 * An HTML layer over the whole mascot holding SVG in its viewBox, so a loop on it is a compositor
 * transform or opacity. `origin` is in viewBox units.
 */
export function Layer({
  ref,
  className,
  origin,
  style,
  children,
}: {
  ref?: Ref<HTMLSpanElement>;
  className?: string;
  origin?: Point;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <span
      ref={ref}
      className={cx('absolute inset-0', className)}
      style={origin ? { transformOrigin: `${origin.x}% ${origin.y}%`, ...style } : style}
    >
      <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
        {children}
      </svg>
    </span>
  );
}

/** HTML layers of a prop enter and leave like `Prop`, from the same origin (viewBox units). */
export function PropLayer({ origin, children }: { origin: Point; children: ReactNode }) {
  return (
    <motion.span
      className="absolute inset-0"
      style={{ originX: origin.x / 100, originY: origin.y / 100 }}
      {...PROP_LAYER}
    >
      {children}
    </motion.span>
  );
}

/** Props and bubbles enter and leave with a quick scale and fade. */
export function Prop({ children, origin = 'center' }: { children: ReactNode; origin?: string }) {
  return (
    <motion.g
      style={{ transformBox: 'fill-box', transformOrigin: origin }}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1, transition: spring.snappy }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: dur.fast, ease: ease.out } }}
    >
      {children}
    </motion.g>
  );
}

/**
 * One-shot states: a state plays for `ms` (0: never settles) before it settles (done into idle, error's ×-eyes
 * into a worried look). With `settle` false it holds, for the character sheets.
 */
export function useSettled<S extends string>(state: S, ms: number, settle: boolean): boolean {
  const [phase, setPhase] = useState({ for: state, settled: false });
  if (phase.for !== state) setPhase({ for: state, settled: false });
  useEffect(() => {
    if (!ms || !settle) return;
    const timer = setTimeout(() => setPhase({ for: state, settled: true }), ms);
    return () => clearTimeout(timer);
  }, [state, ms, settle]);
  return phase.for === state && phase.settled;
}

/**
 * Whether a character animates (Full and on screen, counted in the crowd), plus its idle
 * variety: a random loop phase, blinks every 2–6 s and a look-around every 8–15 s, on the refs
 * this returns.
 */
export function useCharacterLife(
  rootRef: RefObject<HTMLSpanElement | null>,
  { blinks, looks }: { blinks: boolean; looks: boolean },
) {
  const level = useMotionLevel();
  const inView = useInView(rootRef);
  const live = level === 'full' && inView;
  useCrewCrowd(live, rootRef);

  const [loopDelay] = useState(() => `${-between(0, 4).toFixed(2)}s`);
  const lookRef = useRef<HTMLDivElement>(null);
  const eyeLookRef = useRef<HTMLSpanElement>(null);
  const blinkRef = useRef<HTMLSpanElement>(null);
  const blinking = live && blinks;
  const looking = live && looks;

  useEffect(() => {
    if (!blinking) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(
        () => {
          if (blinkRef.current)
            animate(
              blinkRef.current,
              { scaleY: [1, 0.1, 1] },
              { duration: dur.fast, ease: ease.inOut },
            );
          next();
        },
        between(...BLINK_EVERY_MS),
      );
    };
    next();
    return () => clearTimeout(timer);
  }, [blinking]);

  // Read by the look-around's cleanup, which runs after the level has already changed.
  const stillRef = useRef(level !== 'full');
  stillRef.current = level !== 'full';
  useEffect(() => {
    if (!looking) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(
        () => {
          const side = Math.random() < 0.5 ? -1 : 1;
          const hold: Transition = { duration: 1.6, times: [0, 0.2, 0.75, 1], ease: ease.inOut };
          if (eyeLookRef.current)
            animate(eyeLookRef.current, { x: ['0%', `${4 * side}%`, `${4 * side}%`, '0%'] }, hold);
          if (lookRef.current)
            animate(lookRef.current, { rotate: [0, 4 * side, 4 * side, 0] }, hold);
          next();
        },
        between(...LOOK_AROUND_EVERY_MS),
      );
    };
    next();
    return () => {
      clearTimeout(timer);
      // Off screen or at Full it eases back; a drop to Reduced lands at rest without moving.
      const back = stillRef.current ? { duration: 0 } : spring.smooth;
      if (eyeLookRef.current) animate(eyeLookRef.current, { x: '0%' }, back);
      if (lookRef.current) animate(lookRef.current, { rotate: 0 }, back);
    };
  }, [looking]);

  return { level, live, loopDelay, lookRef, eyeLookRef, blinkRef };
}
