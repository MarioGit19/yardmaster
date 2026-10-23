import type { BackgroundKind } from '@c-board/protocol';
import { AnimatePresence, motion } from 'motion/react';
import { type CSSProperties, useId, useRef } from 'react';
import { useRateLoop } from '../anim/useRateLoop.js';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
import { ClaudeOrb } from '../orb/ClaudeOrb.js';
import { cx } from '../ui/cx.js';
import {
  DONE_MS,
  ERROR_X_EYES_MS,
  MAX_HELPERS,
  type MascotDetail,
  type MascotState,
  mascotDetail,
  mascotLabel,
  mascotOrbState,
  miniCrewCount,
  STATE_TOOL,
} from './model.js';
import {
  box,
  Layer,
  type Point,
  PROP_LAYER,
  Prop,
  PropLayer,
  useCharacterLife,
  useSettled,
} from './parts.js';
import { armLVariants, armRVariants, bodyVariants, type CrewPose, eyeVariants } from './poses.js';

export interface CrewMascotProps {
  state: MascotState;
  /** CSS px: 24 (session row), 56 (pod header) or 120 (focus header). */
  size?: number;
  /** Session color for the visor glow and antenna orb, e.g. `var(--accent-3)`. */
  color?: string;
  /** The running tool, for the label and the antenna orb's particles. */
  tool?: string | null;
  /** Running subagents, shown as mini crew members beside this one. */
  subagents?: number;
  /** Running background shells, monitors and tasks: a helper drone each (3 at most, then "+N"). */
  helpers?: readonly BackgroundKind[];
  /** 0..1 terminal output rate; the "watching" monitor flickers faster with it. */
  activity?: number;
  /** Epoch ms; the antenna orb fills a countdown ring while an approval waits. */
  countdown?: { startedAt: number; endsAt: number } | null;
  /**
   * False holds one-shot states (done's sparkle, error's ×-eyes) instead of settling into
   * idle or a worried look. For the character sheet.
   */
  settle?: boolean;
  /** `drawing`: standing at the Office whiteboard (DESIGN.md §10.3), marker raised to it. */
  pose?: 'drawing';
  className?: string;
}

type EyeShape = 'open' | 'closed' | 'x' | 'worried';

const ORB_Y = 17;
/** Where the eyes scale and blink from: the centre of the open eyes, in viewBox units. */
const EYES: Point = { x: 50, y: 55 };
/** Where each arm hangs from, in viewBox units: the top centre of its limb. */
const SHOULDER = { l: { x: 23.5, y: 55.5 }, r: { x: 76.5, y: 55.5 } } as const;

/**
 * The crew member, DESIGN.md §4.11: an original SVG character that acts out its session.
 * Poses blend through Motion variants; the repeating loops (breathing, taps, scanning) are
 * CSS keyframes, paused off screen and dropped at Reduced. Every loop runs on an HTML layer
 * (`Layer`), which the compositor animates, rather than inside an SVG, which would repaint every
 * frame. Layers span the mascot's box, so their offsets in % are viewBox units.
 */
export function CrewMascot({
  state,
  size = 56,
  color = 'var(--st-work)',
  tool = null,
  subagents = 0,
  helpers = NO_HELPERS,
  activity = 0,
  countdown = null,
  settle = true,
  pose,
  className,
}: CrewMascotProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const detail = mascotDetail(size);
  const id = useId();

  // One-shot phases: done settles into idle, error's ×-eyes into a worried look.
  const settled = useSettled(
    state,
    state === 'done' ? DONE_MS : state === 'error' ? ERROR_X_EYES_MS : 0,
    settle,
  );
  const shown: MascotState = state === 'done' && settled ? 'idle' : state;
  const level = useMotionLevel();
  const eyes: EyeShape =
    shown === 'sleeping'
      ? 'closed'
      : shown === 'error'
        ? (settled || level !== 'full') && settle
          ? 'worried'
          : 'x'
        : 'open';
  const { live, loopDelay, lookRef, eyeLookRef, blinkRef } = useCharacterLife(rootRef, {
    blinks: eyes === 'open',
    looks: shown === 'idle',
  });

  const minis = detail === 'posture' ? 0 : miniCrewCount(shown, subagents);
  // Drawing at the whiteboard stands in for the acting, unless the session needs you.
  const act: CrewPose =
    pose === 'drawing' && shown !== 'waiting' && shown !== 'error' ? pose : shown;
  const label =
    act === 'drawing'
      ? 'Drawing on the whiteboard'
      : mascotLabel(shown, tool, miniCrewCount(shown, subagents), helpers.length);
  const orbSize = Math.max(7, Math.round(size * 0.2));
  const props = detail !== 'posture';
  const bubbles = props && level !== 'off';
  const eyeColor = shown === 'error' ? 'var(--st-err)' : color;

  return (
    <span
      ref={rootRef}
      role="img"
      aria-label={label}
      title={label}
      data-crew={shown}
      data-crew-pose={act === 'drawing' ? act : undefined}
      data-crew-detail={detail}
      data-crew-paused={live ? undefined : ''}
      data-crew-hold={settle ? undefined : ''}
      className={cx('crew relative inline-block shrink-0 align-middle', className)}
      style={
        {
          width: size,
          height: size,
          '--crew-delay': loopDelay,
          '--crew-color': color,
        } as CSSProperties
      }
    >
      <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
        <ellipse cx="50" cy="95" rx="22" ry="3" fill="var(--text-1)" opacity="0.08" />
        <rect x="37" y="78" width="10" height="16" rx="5" className="crew-limb crew-leg-l" />
        <rect x="53" y="78" width="10" height="16" rx="5" className="crew-limb crew-leg-r" />
      </svg>

      <motion.div
        aria-hidden
        className="absolute inset-0"
        style={{ originX: 0.5, originY: 0.9 }}
        variants={bodyVariants(size)}
        initial={false}
        animate={act}
      >
        <div ref={lookRef} className="absolute inset-0" style={{ transformOrigin: '50% 90%' }}>
          <div className={cx('crew-anim absolute inset-0', `crew-body-${act}`)}>
            <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
              <defs>
                <radialGradient id={`${id}v`} cx="50%" cy="30%" r="80%">
                  <stop offset="0" style={{ stopColor: color, stopOpacity: 0.22 }} />
                  <stop offset="1" style={{ stopColor: color, stopOpacity: 0 }} />
                </radialGradient>
              </defs>
              <line
                x1="50"
                y1="33"
                x2="50"
                y2={ORB_Y + 3}
                stroke="var(--line-strong)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
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
              <rect x="33" y="44" width="34" height="22" rx="11" fill="var(--crew-visor)" />
              <rect x="33" y="44" width="34" height="22" rx="11" fill={`url(#${id}v)`} />
            </svg>
            <motion.span
              className="absolute inset-0"
              style={{ originX: EYES.x / 100, originY: EYES.y / 100 }}
              variants={eyeVariants}
            >
              <span ref={eyeLookRef} className="absolute inset-0">
                <span className={cx('crew-anim absolute inset-0', `crew-eyes-${act}`)}>
                  <Layer ref={blinkRef} origin={EYES}>
                    <Eyes shape={eyes} color={eyeColor} />
                  </Layer>
                </span>
              </span>
            </motion.span>
            <AnimatePresence initial={false}>
              {props && act === 'reading' && <Page key="page" detail={detail} />}
              {props && act === 'error' && (
                <PropLayer key="sweat" origin={{ x: 71, y: 37.25 }}>
                  <Layer className="crew-anim crew-sweat">
                    <path d="M71 33 Q74.5 39 71 41.5 Q67.5 39 71 33Z" fill="var(--orb-read)" />
                  </Layer>
                </PropLayer>
              )}
            </AnimatePresence>
            <Arm side="l" act={act} />
            <Arm side="r" act={act} />
            <span
              className="absolute"
              style={{
                left: size / 2 - orbSize / 2,
                top: (size * ORB_Y) / 100 - orbSize / 2,
              }}
            >
              <ClaudeOrb
                state={mascotOrbState(shown)}
                size={orbSize}
                accent={color}
                tool={tool ?? STATE_TOOL[shown] ?? null}
                subagents={detail === 'posture' ? miniCrewCount(shown, subagents) : 0}
                countdown={shown === 'waiting' ? countdown : null}
                showToolLabel={false}
              />
            </span>
          </div>
        </div>
      </motion.div>

      {props && (
        <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
          <AnimatePresence initial={false}>
            {act === 'typing' && <Keyboard key="keys" detail={detail} />}
            {act === 'watching' && <Monitor key="mon" />}
            {act === 'running' && <TerminalProp key="term" />}
            {bubbles && act === 'thinking' && <ThinkBubble key="think" />}
            {bubbles && act === 'done' && <Sparkles key="spark" />}
          </AnimatePresence>
        </svg>
      )}

      {props && (
        <span aria-hidden className="pointer-events-none absolute inset-0">
          <AnimatePresence initial={false}>
            {act === 'watching' && (
              <MonitorScreen
                key="mon"
                detail={detail}
                activity={activity}
                size={size}
                live={live}
              />
            )}
            {act === 'running' && <TerminalScreen key="term" detail={detail} />}
            {act === 'typing' && <Glyphs key="keys" color={color} />}
            {bubbles && act === 'thinking' && <ThinkDots key="think" />}
            {bubbles && act === 'waiting' && <AlertBubble key="alert" />}
            {bubbles && act === 'sleeping' && <Snore key="z" detail={detail} />}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {helpers.slice(0, MAX_HELPERS).map((kind, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a slot keeps its drone while tasks come and go.
              <Helper key={i} slot={i} kind={kind} />
            ))}
            {helpers.length > MAX_HELPERS && (
              <motion.span
                key="more"
                data-crew-helpers-more
                className="absolute rounded-chip border border-line bg-bg-2 px-0.5 font-mono text-text-2 tabular leading-none"
                style={{ ...HELPER_SLOTS[MAX_HELPERS], fontSize: Math.max(8, size * 0.09) }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
                transition={{ duration: dur.base, ease: ease.out }}
              >
                +{helpers.length - MAX_HELPERS}
              </motion.span>
            )}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {Array.from({ length: minis }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: mini crew members are interchangeable.
              <MiniCrew key={i} index={i} size={size} color={color} />
            ))}
          </AnimatePresence>
        </span>
      )}
    </span>
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
            <circle cx="43" cy="55" r="6.5" opacity="0.28" stroke="none" />
            <circle cx="57" cy="55" r="6.5" opacity="0.28" stroke="none" />
            <circle cx="43" cy="55" r="3.4" stroke="none" />
            <circle cx="57" cy="55" r="3.4" stroke="none" />
          </>
        )}
        {shape === 'closed' && (
          <>
            <line x1="39.5" y1="56" x2="46.5" y2="56" />
            <line x1="53.5" y1="56" x2="60.5" y2="56" />
          </>
        )}
        {shape === 'x' && (
          <>
            <path d="M40 52 L46 58 M46 52 L40 58" fill="none" />
            <path d="M54 52 L60 58 M60 52 L54 58" fill="none" />
          </>
        )}
        {shape === 'worried' && (
          <>
            <ellipse cx="43" cy="57" rx="3.2" ry="2.4" stroke="none" />
            <ellipse cx="57" cy="57" rx="3.2" ry="2.4" stroke="none" />
            <path d="M39.5 50.5 L46 49 M60.5 50.5 L54 49" fill="none" strokeWidth="1.6" />
          </>
        )}
      </motion.g>
    </AnimatePresence>
  );
}

/**
 * An arm on its own HTML layer over the body: its pose rotates it about the shoulder, and its
 * loop (typing taps, the waiting wave) is a compositor transform.
 */
function Arm({ side, act }: { side: 'l' | 'r'; act: CrewPose }) {
  const shoulder = SHOULDER[side];
  return (
    <motion.div
      aria-hidden
      className="absolute inset-0"
      style={{ originX: shoulder.x / 100, originY: shoulder.y / 100 }}
      variants={side === 'l' ? armLVariants : armRVariants}
    >
      <div
        className={cx('crew-anim absolute inset-0', `crew-arm-${side}-${act}`)}
        style={{ transformOrigin: `${shoulder.x}% ${shoulder.y}%` }}
      >
        <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
          <rect x={shoulder.x - 4.5} y="53" width="9" height="21" rx="4.5" className="crew-limb" />
          {act === 'drawing' && side === 'r' && (
            <rect
              x={shoulder.x - 1.8}
              y="71"
              width="3.6"
              height="9"
              rx="1.2"
              fill="var(--crew-color)"
            />
          )}
        </svg>
      </div>
    </motion.div>
  );
}

/** The page being read, on the body; the magnifier scans it on its own layer. */
function Page({ detail }: { detail: MascotDetail }) {
  const detailed = detail === 'detailed';
  return (
    <PropLayer origin={detailed ? { x: 51, y: 74.5 } : { x: 50, y: 74.5 }}>
      <Layer>
        <rect x="37" y="65" width="26" height="19" rx="2" className="crew-prop" />
        <g stroke="var(--text-3)" strokeWidth="1.5" strokeLinecap="round">
          <line x1="41" y1="70" x2="57" y2="70" />
          <line x1="41" y1="74.5" x2="59" y2="74.5" />
          {detailed && <line x1="41" y1="79" x2="53" y2="79" />}
        </g>
      </Layer>
      {detailed && (
        <Layer className="crew-anim crew-magnifier">
          <g fill="none" stroke="var(--text-2)">
            <circle cx="58" cy="73" r="4.5" strokeWidth="1.5" />
            <line x1="61.2" y1="76.2" x2="65" y2="80" strokeWidth="2" />
          </g>
        </Layer>
      )}
    </PropLayer>
  );
}

function Keyboard({ detail }: { detail: MascotDetail }) {
  return (
    <Prop>
      <rect x="22" y="77" width="56" height="12" rx="3" className="crew-prop" />
      {detail === 'detailed' && (
        <g fill="var(--line-strong)">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <rect key={i} x={26 + i * 7} y="80" width="5" height="2.5" rx="0.8" />
          ))}
          <rect x="33" y="84" width="34" height="2.5" rx="0.8" />
        </g>
      )}
    </Prop>
  );
}

const GLYPHS = [
  { x: 38, char: '{', delay: '0s' },
  { x: 52, char: ';', delay: '-0.4s' },
  { x: 64, char: '/', delay: '-0.8s' },
];

/** Code rising off the keyboard, over the `Keyboard` prop. */
function Glyphs({ color }: { color: string }) {
  return (
    <PropLayer origin={{ x: 50, y: 79.5 }}>
      {GLYPHS.map(({ x, char, delay }) => (
        <Layer key={x} className="crew-anim crew-glyph" style={{ animationDelay: delay }}>
          <text x={x} y="76" fill={color} className="font-mono" fontSize="8" textAnchor="middle">
            {char}
          </text>
        </Layer>
      ))}
    </PropLayer>
  );
}

function Monitor() {
  return (
    <Prop>
      <line x1="16" y1="80" x2="16" y2="86" stroke="var(--line-strong)" strokeWidth="2" />
      <rect x="6" y="85" width="20" height="2.5" rx="1.2" fill="var(--line-strong)" />
      <rect
        x="1"
        y="61"
        width="30"
        height="20"
        rx="3"
        fill="var(--crew-visor)"
        className="crew-outline"
      />
    </Prop>
  );
}

const FLICKER_STEPS = 'steps(3, jump-none)';
const FLICKER = {
  keyframes: [
    { offset: 0, opacity: 0.85, easing: FLICKER_STEPS },
    { offset: 0.4, opacity: 0.45, easing: FLICKER_STEPS },
    { offset: 0.6, opacity: 0.7, easing: FLICKER_STEPS },
    { offset: 1, opacity: 0.85 },
  ],
  durationMs: 1200,
};

/**
 * The monitor's screen, over the frame `Monitor` draws: its flicker is a compositor opacity
 * whose speed eases with the output rate (WAAPI playback rate, so the loop never jumps).
 */
function MonitorScreen({
  detail,
  activity,
  size,
  live,
}: {
  detail: MascotDetail;
  activity: number;
  size: number;
  live: boolean;
}) {
  // Busier output, faster flicker: a 1.2 s cycle at rest down to 0.25 s.
  const busy = Math.min(1, Math.max(0, activity));
  const screenRef = useRef<HTMLSpanElement>(null);
  useRateLoop(screenRef, FLICKER, 1.2 / (1.2 - 0.95 * busy), live);
  return (
    <motion.span className="absolute" style={box(4, 64, 24, 14)} {...PROP_LAYER}>
      <span
        ref={screenRef}
        className="crew-flicker absolute inset-0"
        style={{ background: 'var(--st-ok)', borderRadius: (size * 1.5) / 100 }}
      />
      {detail === 'detailed' && (
        <svg aria-hidden viewBox="0 0 24 14" className="absolute inset-0 size-full">
          <g stroke="var(--crew-visor)" strokeWidth="1.2" opacity="0.7">
            <line x1="3" y1="4" x2="16" y2="4" />
            <line x1="3" y1="7.5" x2="20" y2="7.5" />
            <line x1="3" y1="11" x2="12" y2="11" />
          </g>
        </svg>
      )}
    </motion.span>
  );
}

function TerminalProp() {
  return (
    <Prop>
      <rect
        x="74"
        y="46"
        width="26"
        height="22"
        rx="3"
        fill="var(--crew-visor)"
        className="crew-outline"
      />
    </Prop>
  );
}

const TERMINAL_LINE_GAP = 4.5;

/** The terminal's output, scrolling inside the frame `TerminalProp` draws (compositor). */
function TerminalScreen({ detail }: { detail: MascotDetail }) {
  const lines = detail === 'detailed' ? [12, 8, 14, 6, 11, 9, 13, 7] : [12, 8, 14, 9];
  // Two copies, so scrolling by half loops seamlessly.
  const rows = [...lines, ...lines].map((w, i) => ({
    w,
    y: 2 + i * TERMINAL_LINE_GAP,
    dim: i % 3 === 2,
  }));
  const height = rows.length * TERMINAL_LINE_GAP;
  return (
    <motion.span className="absolute overflow-hidden" style={box(77, 50, 20, 15)} {...PROP_LAYER}>
      <span
        className="crew-anim crew-scroll absolute inset-x-0 top-0"
        style={{ height: `${(height / 15) * 100}%` }}
      >
        <svg
          aria-hidden
          viewBox={`0 0 20 ${height}`}
          className="absolute inset-0 size-full"
          stroke="var(--st-tool)"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          {rows.map(({ w, y, dim }) => (
            <line key={y} x1="1" y1={y} x2={1 + w} y2={y} opacity={dim ? 0.5 : 0.9} />
          ))}
        </svg>
      </span>
    </motion.span>
  );
}

function ThinkBubble() {
  return (
    <Prop origin="0% 100%">
      <circle cx="66" cy="29" r="2" className="crew-prop" />
      <rect x="66" y="7" width="28" height="17" rx="8.5" className="crew-prop" />
    </Prop>
  );
}

/** The thinking dots, over the bubble `ThinkBubble` draws (it grows from its bottom left). */
function ThinkDots() {
  return (
    <PropLayer origin={{ x: 64, y: 31 }}>
      {[73, 80, 87].map((cx, i) => (
        <Layer key={cx} className="crew-anim crew-dot" style={{ animationDelay: `${i * 0.2}s` }}>
          <circle cx={cx} cy="15.5" r="2" fill="var(--text-2)" />
        </Layer>
      ))}
    </PropLayer>
  );
}

export function AlertBubble() {
  return (
    <PropLayer origin={{ x: 13, y: 27 }}>
      <Layer className="crew-anim crew-bounce">
        <circle cx="22" cy="18" r="9" fill="var(--st-wait)" />
        <rect x="20.8" y="12" width="2.4" height="7.5" rx="1.2" fill="var(--bg-0)" />
        <circle cx="22" cy="23" r="1.4" fill="var(--bg-0)" />
      </Layer>
    </PropLayer>
  );
}

export function Snore({ detail }: { detail: MascotDetail }) {
  const zs =
    detail === 'detailed'
      ? [
          { x: 68, y: 30, size: 12, delay: '0s' },
          { x: 74, y: 22, size: 8, delay: '-1.5s' },
        ]
      : [{ x: 68, y: 30, size: 12, delay: '0s' }];
  return (
    <PropLayer origin={detail === 'detailed' ? { x: 73, y: 24 } : { x: 72, y: 26 }}>
      {zs.map(({ x, y, size, delay }) => (
        <Layer key={x} className="crew-anim crew-z" style={{ animationDelay: delay }}>
          <text
            x={x}
            y={y}
            fontSize={size}
            className="font-mono"
            fill="var(--text-3)"
            fontWeight="600"
          >
            z
          </text>
        </Layer>
      ))}
    </PropLayer>
  );
}

const SPARKS = [-100, -60, -25, 25, 60, 100].map((deg) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: 50 + Math.cos(rad) * 40, y: 46 + Math.sin(rad) * 40 };
});

function Sparkles() {
  return (
    <g>
      {SPARKS.map(({ x, y }, i) => (
        <path
          key={`${x}-${y}`}
          d={`M${x} ${y - 4} L${x + 1} ${y - 1} L${x + 4} ${y} L${x + 1} ${y + 1} L${x} ${y + 4} L${x - 1} ${y + 1} L${x - 4} ${y} L${x - 1} ${y - 1} Z`}
          fill="var(--st-ok)"
          className="crew-anim crew-spark"
          style={{ animationDelay: `${i * 0.04}s` }}
        />
      ))}
    </g>
  );
}

const PUFF = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

const NO_HELPERS: readonly BackgroundKind[] = [];

/** Where helper drones hover, in % of the mascot's box: beside the head, then by the left arm. */
const HELPER_SLOTS: readonly CSSProperties[] = [
  { left: '1%', top: '6%' },
  { left: '79%', top: '6%' },
  { left: '1%', top: '30%' },
  { left: '79%', top: '30%' },
];

const HELPER_EYE: Record<BackgroundKind, string> = {
  shell: 'var(--st-tool)',
  monitor: 'var(--st-tool)',
  agent: 'var(--orb-task)',
  other: 'var(--st-work)',
};

/** A background task's helper: a small drone that pops in beside the crew member and hovers. */
function Helper({ slot, kind }: { slot: number; kind: BackgroundKind }) {
  return (
    <motion.span
      data-crew-helper={kind}
      className="absolute"
      style={{ ...HELPER_SLOTS[slot], width: '20%', height: '20%', originX: 0.5, originY: 0.5 }}
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1, transition: spring.snappy }}
      exit={{ scale: 0.4, opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
    >
      <span className="crew-anim crew-helper absolute inset-0">
        <svg aria-hidden viewBox="0 0 20 20" className="absolute inset-0 overflow-visible">
          <line x1="5" y1="3" x2="15" y2="3" className="crew-outline" strokeLinecap="round" />
          <line x1="10" y1="3" x2="10" y2="6" className="crew-outline" />
          <rect x="3" y="6" width="14" height="11" rx="5" className="crew-shell" />
          <rect x="5.5" y="9" width="9" height="4.5" rx="2.25" fill="var(--crew-visor)" />
          <circle cx="10" cy="11.25" r="1.4" fill={HELPER_EYE[kind]} />
        </svg>
      </span>
    </motion.span>
  );
}

/** A subagent: pops out beside its parent with a small puff and leaves the same way. */
function MiniCrew({ index, size, color }: { index: number; size: number; color: string }) {
  const mini = Math.round(size * 0.46);
  return (
    <motion.span
      className="absolute bottom-0"
      style={{ left: size * 0.98 + index * mini * 0.62, width: mini, height: mini }}
      initial="hidden"
      animate="shown"
      exit="gone"
    >
      <motion.span
        className="absolute inset-0"
        style={{ originX: 0.5, originY: 1 }}
        variants={{
          hidden: { scale: 0.4, opacity: 0 },
          shown: { scale: 1, opacity: 1, transition: spring.snappy },
          gone: { scale: 0.4, opacity: 0, transition: { duration: dur.fast, ease: ease.out } },
        }}
      >
        {/* Breathes from where its body meets the ground, as the parent does. */}
        <Layer className="crew-anim crew-body-idle" origin={{ x: 50, y: 78.8 }}>
          <line x1="50" y1="33" x2="50" y2="20" stroke="var(--line-strong)" strokeWidth="3" />
          <circle cx="50" cy="17" r="6" fill="var(--orb-task)" />
          <rect x="27" y="32" width="46" height="56" rx="23" className="crew-shell" />
          <rect x="33" y="45" width="34" height="22" rx="11" fill="var(--crew-visor)" />
          <circle cx="43" cy="56" r="4" fill={color} />
          <circle cx="57" cy="56" r="4" fill={color} />
        </Layer>
      </motion.span>
      <motion.svg
        viewBox="0 0 100 100"
        className="absolute inset-0 overflow-visible"
        variants={{
          hidden: { opacity: 0, scale: 0.6 },
          shown: {
            opacity: [0.7, 0],
            scale: [0.6, 1.5],
            transition: { duration: dur.slow, ease: ease.out },
          },
          gone: {
            opacity: [0.7, 0],
            scale: [0.6, 1.5],
            transition: { duration: dur.base, ease: ease.out },
          },
        }}
      >
        {PUFF.map(([dx, dy]) => (
          <circle
            key={`${dx}${dy}`}
            cx={50 + dx * 30}
            cy={60 + dy * 24}
            r="7"
            fill="var(--text-3)"
          />
        ))}
      </motion.svg>
    </motion.span>
  );
}
