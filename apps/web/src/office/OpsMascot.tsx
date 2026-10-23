import { AnimatePresence, motion } from 'motion/react';
import { type CSSProperties, useId, useRef } from 'react';
import { AlertBubble, Snore } from '../crew/CrewMascot.js';
import { mascotDetail } from '../crew/model.js';
import {
  box,
  Layer,
  type Point,
  PROP_LAYER,
  Prop,
  useCharacterLife,
  useSettled,
} from '../crew/parts.js';
import { type Pose, poseVariants } from '../crew/poses.js';
import { dur, ease } from '../motion.js';
import { cx } from '../ui/cx.js';
import { ExitBadge } from '../ui/ExitBadge.js';
import { LedRow, ScrollingLines } from './kit/loops.js';
import { OPS_COLOR, OPS_DONE_MS, OPS_X_EYES_MS, type OpsMascotState, opsLabel } from './ops.js';

export interface OpsMascotProps {
  state: OpsMascotState;
  /** CSS px: 24, 56 (the Office building) or 120 (the room view). */
  size?: number;
  /** Visor color; defaults to the state's status color. */
  color?: string;
  /** 0..1 output rate: the progress screen scrolls and the rack's lights blink faster with it. */
  activity?: number;
  /** The failed command's exit code, for the label and the rose badge above. */
  exit?: number | null;
  /** False holds one-shot states (done's thumbs-up, error's ×-eyes). For the kit sheet. */
  settle?: boolean;
  className?: string;
}

type EyeShape = 'open' | 'closed' | 'x' | 'worried' | 'happy';

// Ops poses in viewBox units, like the crew's (crew/poses.ts). The rack stands on the left, the
// workbench's screen on the right.
const OPS_POSES: Record<OpsMascotState, Pose> = {
  idle: { body: { y: 0, rotate: 0, scale: 1 }, armL: 10, armR: -10, eyes: { x: 0, y: 0 } },
  sleeping: { body: { y: 3, rotate: 0, scale: 0.98 }, armL: 4, armR: -4, eyes: { x: 0, y: 2 } },
  // Types the command, then lifts the hand and watches the screen.
  running: {
    body: { y: 1, rotate: 3, scale: 1 },
    armL: -28,
    armR: [-10, 30, 12],
    eyes: { x: 4, y: 2 },
  },
  // Stands tall at the rack, a hand resting on it.
  serving: { body: { y: -1, rotate: -3, scale: 1 }, armL: 62, armR: -12, eyes: { x: -4, y: 0 } },
  done: { body: { y: -2, rotate: 0, scale: 1 }, armL: 10, armR: -150, eyes: { x: 0, y: -2 } },
  error: {
    body: { y: 0, rotate: 0, scale: 1, x: [0, -3, 3, -2, 2, 0] },
    armL: 26,
    armR: -26,
    eyes: { x: 0, y: 1 },
  },
  waiting: {
    body: { y: -1, rotate: 0, scale: 1.04 },
    armL: 12,
    armR: -165,
    eyes: { x: 0, y: 0, scale: 1.18 },
  },
};

const variants = poseVariants(OPS_POSES);

const SHOULDER = { l: { x: 23.5, y: 55.5 }, r: { x: 76.5, y: 55.5 } } as const;
const EYES: Point = { x: 50, y: 54 };

/**
 * The ops crew, DESIGN.md §10.3: the crew mascot's sibling for terminals. Same body and part
 * structure (crew/parts.tsx), with a rectangular visor in the terminal's status color and a
 * headset instead of the antenna orb. Poses blend through Motion variants; loops are CSS or
 * WAAPI on HTML layers, paused off screen and gone at Reduced.
 */
export function OpsMascot({
  state,
  size = 56,
  color,
  activity = 0,
  exit = null,
  settle = true,
  className,
}: OpsMascotProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const detail = mascotDetail(size);
  const id = useId();

  const settled = useSettled(
    state,
    state === 'done' ? OPS_DONE_MS : state === 'error' ? OPS_X_EYES_MS : 0,
    settle,
  );
  const shown: OpsMascotState = state === 'done' && settled ? 'idle' : state;
  const eyes: EyeShape =
    shown === 'sleeping'
      ? 'closed'
      : shown === 'done'
        ? 'happy'
        : shown === 'error'
          ? settled
            ? 'worried'
            : 'x'
          : 'open';
  const { level, live, loopDelay, lookRef, eyeLookRef, blinkRef } = useCharacterLife(rootRef, {
    blinks: eyes === 'open',
    looks: shown === 'idle',
  });

  const visor = color ?? OPS_COLOR[shown];
  const props = detail !== 'posture';
  const bubbles = props && level !== 'off';
  const label = opsLabel(shown, exit);

  return (
    <span
      ref={rootRef}
      role="img"
      aria-label={label}
      title={label}
      data-ops={shown}
      data-crew-detail={detail}
      data-crew-paused={live ? undefined : ''}
      data-crew-hold={settle ? undefined : ''}
      className={cx('crew relative inline-block shrink-0 align-middle', className)}
      style={
        {
          width: size,
          height: size,
          '--crew-delay': loopDelay,
          '--crew-color': visor,
        } as CSSProperties
      }
    >
      {props && (
        <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
          <AnimatePresence initial={false}>
            {shown === 'serving' && <MiniRack key="rack" />}
          </AnimatePresence>
        </svg>
      )}

      <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
        <ellipse cx="50" cy="95" rx="22" ry="3" fill="var(--text-1)" opacity="0.08" />
        <rect x="37" y="78" width="10" height="16" rx="5" className="crew-limb crew-leg-l" />
        <rect x="53" y="78" width="10" height="16" rx="5" className="crew-limb crew-leg-r" />
      </svg>

      <motion.div
        aria-hidden
        className="absolute inset-0"
        style={{ originX: 0.5, originY: 0.9 }}
        variants={variants.body(size)}
        initial={false}
        animate={shown}
      >
        <div ref={lookRef} className="absolute inset-0" style={{ transformOrigin: '50% 90%' }}>
          <div className={cx('crew-anim absolute inset-0', `crew-body-${shown}`)}>
            <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
              <defs>
                <linearGradient id={`${id}v`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" style={{ stopColor: visor, stopOpacity: 0.26 }} />
                  <stop offset="1" style={{ stopColor: visor, stopOpacity: 0.04 }} />
                </linearGradient>
              </defs>
              <rect x="27" y="32" width="46" height="54" rx="23" className="crew-shell" />
              <path
                d="M33 46 Q35 37 45 34.5"
                fill="none"
                stroke="var(--text-1)"
                strokeOpacity="0.08"
                strokeWidth="1.5"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <rect x="31" y="44" width="38" height="20" rx="4" fill="var(--crew-visor)" />
              <rect x="31" y="44" width="38" height="20" rx="4" fill={`url(#${id}v)`} />
              <Headset color={visor} />
            </svg>
            <motion.span
              className="absolute inset-0"
              style={{ originX: EYES.x / 100, originY: EYES.y / 100 }}
              variants={variants.eyes}
            >
              <span ref={eyeLookRef} className="absolute inset-0">
                <span className={cx('crew-anim absolute inset-0', `crew-eyes-${shown}`)}>
                  <Layer ref={blinkRef} origin={EYES}>
                    <Eyes shape={eyes} color={visor} />
                  </Layer>
                </span>
              </span>
            </motion.span>
            <Arm side="l" shown={shown} />
            <Arm side="r" shown={shown} />
          </div>
        </div>
      </motion.div>

      {props && (
        <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
          <AnimatePresence initial={false}>
            {shown === 'running' && <BenchScreen key="screen" />}
            {bubbles && shown === 'done' && <CheckBurst key="check" />}
            {shown === 'error' && <ErrorSpark key="spark" />}
          </AnimatePresence>
        </svg>
      )}

      {props && (
        <span aria-hidden className="pointer-events-none absolute inset-0">
          <AnimatePresence initial={false}>
            {shown === 'running' && (
              <motion.span key="screen" className="absolute inset-0" {...PROP_LAYER}>
                <ScrollingLines
                  lines={detail === 'detailed' ? [70, 45, 85, 35, 60, 50] : [70, 45, 85, 50]}
                  color="var(--st-tool)"
                  rate={activity}
                  running={live}
                  style={box(79, 48, 18, 14)}
                />
              </motion.span>
            )}
            {shown === 'serving' && (
              <motion.span key="rack" className="absolute inset-0" {...PROP_LAYER}>
                {[0, 1, 2].map((row) => (
                  <LedRow
                    key={row}
                    count={2}
                    color="var(--st-ok)"
                    rate={activity}
                    seed={row + 1}
                    style={box(4.5, 52 + row * 11, 8, 3)}
                  />
                ))}
              </motion.span>
            )}
            {bubbles && shown === 'waiting' && <AlertBubble key="alert" />}
            {bubbles && shown === 'sleeping' && <Snore key="z" detail={detail} />}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {shown === 'error' && exit !== null && (
              // The badge pops itself in; acknowledged, it fades out.
              <motion.span
                key="exit"
                data-ops-exit
                className="absolute left-1/2 -translate-x-1/2"
                style={{ top: detail === 'detailed' ? '4%' : '-14%' }}
                exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
              >
                <ExitBadge code={exit} />
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      )}
    </span>
  );
}

/** The headset: a band over the head, ear cups and a mic boom whose tip glows in the visor color. */
function Headset({ color }: { color: string }) {
  return (
    <g>
      <path
        d="M27.5 46 C27.5 20 72.5 20 72.5 46"
        fill="none"
        stroke="var(--text-3)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <rect x="22.5" y="38" width="8" height="14" rx="3.5" className="crew-shell" />
      <rect x="69.5" y="38" width="8" height="14" rx="3.5" className="crew-shell" />
      <path
        d="M25 51 Q24.5 66 37 68"
        fill="none"
        stroke="var(--text-3)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="38.5" cy="68" r="2.6" fill={color} />
    </g>
  );
}

function Eyes({ shape, color }: { shape: EyeShape; color: string }) {
  return (
    <AnimatePresence initial={false}>
      <motion.g
        key={shape}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: dur.fast, ease: ease.out }}
        stroke={color}
        fill={color}
        strokeWidth="2.2"
        strokeLinecap="round"
      >
        {shape === 'open' && (
          <>
            <rect x="36" y="48.5" width="14" height="11" rx="3" opacity="0.26" stroke="none" />
            <rect x="50" y="48.5" width="14" height="11" rx="3" opacity="0.26" stroke="none" />
            <rect x="39" y="51" width="8" height="6" rx="1.8" stroke="none" />
            <rect x="53" y="51" width="8" height="6" rx="1.8" stroke="none" />
          </>
        )}
        {shape === 'closed' && (
          <>
            <line x1="39" y1="55" x2="47" y2="55" />
            <line x1="53" y1="55" x2="61" y2="55" />
          </>
        )}
        {shape === 'happy' && (
          <path d="M39 56.5 L43 51.5 L47 56.5 M53 56.5 L57 51.5 L61 56.5" fill="none" />
        )}
        {shape === 'x' && (
          <>
            <path d="M40 51 L46 57 M46 51 L40 57" fill="none" />
            <path d="M54 51 L60 57 M60 51 L54 57" fill="none" />
          </>
        )}
        {shape === 'worried' && (
          <>
            <rect x="39.5" y="54" width="7" height="4" rx="1.5" stroke="none" />
            <rect x="53.5" y="54" width="7" height="4" rx="1.5" stroke="none" />
            <path d="M39 50 L46 48.5 M61 50 L54 48.5" fill="none" strokeWidth="1.6" />
          </>
        )}
      </motion.g>
    </AnimatePresence>
  );
}

function Arm({ side, shown }: { side: 'l' | 'r'; shown: OpsMascotState }) {
  const shoulder = SHOULDER[side];
  return (
    <motion.div
      aria-hidden
      className="absolute inset-0"
      style={{ originX: shoulder.x / 100, originY: shoulder.y / 100 }}
      variants={side === 'l' ? variants.armL : variants.armR}
    >
      <div
        className={cx('crew-anim absolute inset-0', `crew-arm-${side}-${shown}`)}
        style={{ transformOrigin: `${shoulder.x}% ${shoulder.y}%` }}
      >
        <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
          <rect x={shoulder.x - 4.5} y="53" width="9" height="21" rx="4.5" className="crew-limb" />
          {side === 'r' && shown === 'done' && (
            // The thumb, up when the arm is raised.
            <rect
              x={shoulder.x - 1.5}
              y="73"
              width="3.4"
              height="6"
              rx="1.7"
              className="crew-limb"
            />
          )}
        </svg>
      </div>
    </motion.div>
  );
}

/** The workbench's progress screen, beside the crew member; its lines are `ScrollingLines`. */
function BenchScreen() {
  return (
    <Prop>
      <rect
        x="76"
        y="45"
        width="24"
        height="20"
        rx="3"
        fill="var(--crew-visor)"
        className="crew-outline"
      />
      <rect x="79" y="66.5" width="18" height="1.8" rx="0.9" fill="var(--line-strong)" />
    </Prop>
  );
}

/** A slim server rack on the left, its lights over it in `LedRow`s. */
function MiniRack() {
  return (
    <Prop origin="50% 100%">
      <rect x="0" y="44" width="17" height="48" rx="2" className="crew-prop" />
      {[0, 1, 2].map((row) => (
        <rect
          key={row}
          x="2.5"
          y={49 + row * 11}
          width="12"
          height="9"
          rx="1"
          fill="var(--crew-visor)"
          opacity="0.8"
        />
      ))}
    </Prop>
  );
}

const SPARKS = [-70, -20, 30, 80].map((deg) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: 80 + Math.cos(rad) * 15, y: 22 + Math.sin(rad) * 15 };
});

/** Done: a check pops out above the raised hand with a small sparkle. */
function CheckBurst() {
  return (
    <g>
      <Prop>
        <circle cx="80" cy="22" r="8.5" fill="var(--st-ok)" />
        <path
          d="M76 22.2 L79 25.2 L84.5 19"
          fill="none"
          stroke="var(--bg-0)"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Prop>
      {SPARKS.map(({ x, y }, i) => (
        <path
          key={`${x}-${y}`}
          d={`M${x} ${y - 3} L${x + 0.8} ${y - 0.8} L${x + 3} ${y} L${x + 0.8} ${y + 0.8} L${x} ${y + 3} L${x - 0.8} ${y + 0.8} L${x - 3} ${y} L${x - 0.8} ${y - 0.8} Z`}
          fill="var(--st-ok)"
          className="crew-anim crew-spark"
          style={{ animationDelay: `${i * 0.05}s` }}
        />
      ))}
    </g>
  );
}

/** Error: the bench or rack sparks once, a small rose bolt beside the crew member. */
function ErrorSpark() {
  return (
    <Prop>
      <path
        d="M17 28 L10 40 L15.5 40 L11 51 L20.5 36.5 L15 36.5 L19 28 Z"
        fill="var(--st-err)"
        className="crew-anim crew-ops-spark"
      />
    </Prop>
  );
}
