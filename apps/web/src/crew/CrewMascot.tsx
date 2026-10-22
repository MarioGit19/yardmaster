import { AnimatePresence, animate, motion, type Transition } from 'motion/react';
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useInView } from '../anim/useFrame.js';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
import { ClaudeOrb } from '../orb/ClaudeOrb.js';
import { cx } from '../ui/cx.js';
import { useCrewCrowd } from './crowd.js';
import {
  BLINK_EVERY_MS,
  between,
  DONE_MS,
  ERROR_X_EYES_MS,
  LOOK_AROUND_EVERY_MS,
  type MascotDetail,
  type MascotState,
  mascotDetail,
  mascotLabel,
  mascotOrbState,
  miniCrewCount,
  STATE_TOOL,
} from './model.js';
import { armLVariants, armRVariants, bodyVariants, eyeVariants } from './poses.js';

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
  /** 0..1 terminal output rate; the "watching" monitor flickers faster with it. */
  activity?: number;
  /**
   * False holds one-shot states (done's sparkle, error's ×-eyes) instead of settling into
   * idle or a worried look. For the character sheet.
   */
  settle?: boolean;
  className?: string;
}

type EyeShape = 'open' | 'closed' | 'x' | 'worried';

const ORB_Y = 17;
/** Where each arm hangs from, in viewBox units: the top centre of its limb. */
const SHOULDER = { l: { x: 23.5, y: 55.5 }, r: { x: 76.5, y: 55.5 } } as const;

/**
 * The crew member, DESIGN.md §4.11: an original SVG character that acts out its session.
 * Poses blend through Motion variants; the repeating loops (breathing, taps, scanning) are
 * CSS keyframes, paused off screen and dropped at Reduced. The fastest loops (typing arms, the
 * terminal's scroll, the monitor's flicker) run on HTML layers, which the compositor animates,
 * rather than inside the SVG, which would repaint every frame.
 */
export function CrewMascot({
  state,
  size = 56,
  color = 'var(--st-work)',
  tool = null,
  subagents = 0,
  activity = 0,
  settle = true,
  className,
}: CrewMascotProps) {
  const level = useMotionLevel();
  const rootRef = useRef<HTMLSpanElement>(null);
  const inView = useInView(rootRef);
  const live = level === 'full' && inView;
  useCrewCrowd(live);
  const detail = mascotDetail(size);
  const id = useId();

  // One-shot phases: done settles into idle, error's ×-eyes into a worried look.
  const [phase, setPhase] = useState({ for: state, settled: false });
  if (phase.for !== state) setPhase({ for: state, settled: false });
  useEffect(() => {
    const ms = state === 'done' ? DONE_MS : state === 'error' ? ERROR_X_EYES_MS : 0;
    if (!ms || !settle) return;
    const timer = setTimeout(() => setPhase({ for: state, settled: true }), ms);
    return () => clearTimeout(timer);
  }, [state, settle]);
  const settled = phase.for === state && phase.settled;
  const shown: MascotState = state === 'done' && settled ? 'idle' : state;
  const eyes: EyeShape =
    shown === 'sleeping'
      ? 'closed'
      : shown === 'error'
        ? (settled || level !== 'full') && settle
          ? 'worried'
          : 'x'
        : 'open';

  // Per-instance variety: a random phase for the loops, random blink and look-around timing.
  const [loopDelay] = useState(() => `${-between(0, 4).toFixed(2)}s`);
  const lookRef = useRef<HTMLDivElement>(null);
  const eyeLookRef = useRef<SVGGElement>(null);
  const blinkRef = useRef<SVGGElement>(null);
  const blinks = live && eyes === 'open';
  const looks = live && shown === 'idle';

  useEffect(() => {
    if (!blinks) return;
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
  }, [blinks]);

  useEffect(() => {
    if (!looks) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(
        () => {
          const side = Math.random() < 0.5 ? -1 : 1;
          const hold: Transition = { duration: 1.6, times: [0, 0.2, 0.75, 1], ease: ease.inOut };
          if (eyeLookRef.current)
            animate(eyeLookRef.current, { x: [0, 4 * side, 4 * side, 0] }, hold);
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
      if (eyeLookRef.current) animate(eyeLookRef.current, { x: 0 }, spring.smooth);
      if (lookRef.current) animate(lookRef.current, { rotate: 0 }, spring.smooth);
    };
  }, [looks]);

  const minis = detail === 'posture' ? 0 : miniCrewCount(shown, subagents);
  const label = mascotLabel(shown, tool, miniCrewCount(shown, subagents));
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
      data-crew-detail={detail}
      data-crew-paused={live ? undefined : ''}
      data-crew-hold={settle ? undefined : ''}
      className={cx('crew relative inline-block shrink-0 align-middle', className)}
      style={{ width: size, height: size, '--crew-delay': loopDelay } as CSSProperties}
    >
      <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
        <ellipse cx="50" cy="95" rx="22" ry="3" fill="var(--text-1)" opacity="0.08" />
        <rect x="37" y="78" width="10" height="16" rx="5" className="crew-limb" />
        <rect x="53" y="78" width="10" height="16" rx="5" className="crew-limb" />
      </svg>

      <motion.div
        aria-hidden
        className="absolute inset-0"
        style={{ originX: 0.5, originY: 0.9 }}
        variants={bodyVariants(size)}
        initial={false}
        animate={shown}
      >
        <div ref={lookRef} className="absolute inset-0" style={{ transformOrigin: '50% 90%' }}>
          <div className={cx('crew-anim absolute inset-0', `crew-body-${shown}`)}>
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
              <motion.g variants={eyeVariants}>
                <g ref={eyeLookRef}>
                  <g className={cx('crew-anim', `crew-eyes-${shown}`)}>
                    <g
                      ref={blinkRef}
                      style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                    >
                      <Eyes shape={eyes} color={eyeColor} />
                    </g>
                  </g>
                </g>
              </motion.g>

              <AnimatePresence initial={false}>
                {props && shown === 'reading' && (
                  <Prop key="page">
                    <rect x="37" y="65" width="26" height="19" rx="2" className="crew-prop" />
                    <g stroke="var(--text-3)" strokeWidth="1.5" strokeLinecap="round">
                      <line x1="41" y1="70" x2="57" y2="70" />
                      <line x1="41" y1="74.5" x2="59" y2="74.5" />
                      {detail === 'detailed' && <line x1="41" y1="79" x2="53" y2="79" />}
                    </g>
                    {detail === 'detailed' && (
                      <g className="crew-anim crew-magnifier" fill="none" stroke="var(--text-2)">
                        <circle cx="58" cy="73" r="4.5" strokeWidth="1.5" />
                        <line x1="61.2" y1="76.2" x2="65" y2="80" strokeWidth="2" />
                      </g>
                    )}
                  </Prop>
                )}
                {props && shown === 'error' && (
                  <Prop key="sweat">
                    <path
                      d="M71 33 Q74.5 39 71 41.5 Q67.5 39 71 33Z"
                      fill="var(--orb-read)"
                      className="crew-anim crew-sweat"
                    />
                  </Prop>
                )}
              </AnimatePresence>
            </svg>
            <Arm side="l" shown={shown} />
            <Arm side="r" shown={shown} />
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
                showToolLabel={false}
              />
            </span>
          </div>
        </div>
      </motion.div>

      {props && (
        <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
          <AnimatePresence initial={false}>
            {shown === 'typing' && <Keyboard key="keys" detail={detail} color={color} />}
            {shown === 'watching' && <Monitor key="mon" />}
            {shown === 'running' && <TerminalProp key="term" />}
            {bubbles && shown === 'thinking' && <ThinkBubble key="think" />}
            {bubbles && shown === 'waiting' && <AlertBubble key="alert" />}
            {bubbles && shown === 'sleeping' && <Snore key="z" detail={detail} />}
            {bubbles && shown === 'done' && <Sparkles key="spark" />}
          </AnimatePresence>
        </svg>
      )}

      {props && (
        <span aria-hidden className="pointer-events-none absolute inset-0">
          <AnimatePresence initial={false}>
            {shown === 'watching' && (
              <MonitorScreen key="mon" detail={detail} activity={activity} size={size} />
            )}
            {shown === 'running' && <TerminalScreen key="term" detail={detail} />}
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
function Arm({ side, shown }: { side: 'l' | 'r'; shown: MascotState }) {
  const shoulder = SHOULDER[side];
  return (
    <motion.div
      aria-hidden
      className="absolute inset-0"
      style={{ originX: shoulder.x / 100, originY: shoulder.y / 100 }}
      variants={side === 'l' ? armLVariants : armRVariants}
    >
      <div
        className={cx('crew-anim absolute inset-0', `crew-arm-${side}-${shown}`)}
        style={{ transformOrigin: `${shoulder.x}% ${shoulder.y}%` }}
      >
        <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 overflow-visible">
          <rect x={shoulder.x - 4.5} y="53" width="9" height="21" rx="4.5" className="crew-limb" />
        </svg>
      </div>
    </motion.div>
  );
}

/** HTML parts of a prop enter and leave like `Prop`. */
const PROP_LAYER = {
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1, transition: spring.snappy },
  exit: { opacity: 0, scale: 0.9, transition: { duration: dur.fast, ease: ease.out } },
};

/** Places an HTML layer over a viewBox rectangle (the mascot's box is square). */
const box = (x: number, y: number, width: number, height: number): CSSProperties => ({
  left: `${x}%`,
  top: `${y}%`,
  width: `${width}%`,
  height: `${height}%`,
});

/** Props and bubbles enter and leave with a quick scale and fade. */
function Prop({ children, origin = 'center' }: { children: ReactNode; origin?: string }) {
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

function Keyboard({ detail, color }: { detail: MascotDetail; color: string }) {
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
      <g fill={color} className="font-mono" fontSize="8" textAnchor="middle">
        <text x="38" y="76" className="crew-anim crew-glyph">
          {'{'}
        </text>
        <text x="52" y="76" className="crew-anim crew-glyph" style={{ animationDelay: '-0.4s' }}>
          ;
        </text>
        <text x="64" y="76" className="crew-anim crew-glyph" style={{ animationDelay: '-0.8s' }}>
          /
        </text>
      </g>
    </Prop>
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

/** The monitor's screen, over the frame `Monitor` draws: its flicker is a compositor opacity. */
function MonitorScreen({
  detail,
  activity,
  size,
}: {
  detail: MascotDetail;
  activity: number;
  size: number;
}) {
  // Busier output, faster flicker: 1.2 s at rest down to 0.25 s.
  const rate = Math.min(1, Math.max(0, activity));
  const flicker = `${(1.2 - 0.95 * rate).toFixed(2)}s`;
  return (
    <motion.span className="absolute" style={box(4, 64, 24, 14)} {...PROP_LAYER}>
      <span
        className="crew-anim crew-flicker absolute inset-0"
        style={{
          background: 'var(--st-ok)',
          borderRadius: (size * 1.5) / 100,
          animationDuration: flicker,
        }}
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
      <g fill="var(--text-2)">
        {[73, 80, 87].map((cx, i) => (
          <circle
            key={cx}
            cx={cx}
            cy="15.5"
            r="2"
            className="crew-anim crew-dot"
            style={{ animationDelay: `${i * 0.2}s` }}
          />
        ))}
      </g>
    </Prop>
  );
}

function AlertBubble() {
  return (
    <Prop origin="0% 100%">
      <g className="crew-anim crew-bounce">
        <circle cx="22" cy="18" r="9" fill="var(--st-wait)" />
        <rect x="20.8" y="12" width="2.4" height="7.5" rx="1.2" fill="var(--bg-0)" />
        <circle cx="22" cy="23" r="1.4" fill="var(--bg-0)" />
      </g>
    </Prop>
  );
}

function Snore({ detail }: { detail: MascotDetail }) {
  return (
    <Prop>
      <g className="font-mono" fill="var(--text-3)" fontWeight="600">
        <text x="68" y="30" fontSize="12" className="crew-anim crew-z">
          z
        </text>
        {detail === 'detailed' && (
          <text
            x="74"
            y="22"
            fontSize="8"
            className="crew-anim crew-z"
            style={{ animationDelay: '-1.5s' }}
          >
            z
          </text>
        )}
      </g>
    </Prop>
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
      <motion.svg
        viewBox="0 0 100 100"
        className="absolute inset-0 overflow-visible"
        style={{ originX: 0.5, originY: 1 }}
        variants={{
          hidden: { scale: 0.4, opacity: 0 },
          shown: { scale: 1, opacity: 1, transition: spring.snappy },
          gone: { scale: 0.4, opacity: 0, transition: { duration: dur.fast, ease: ease.out } },
        }}
      >
        <g className="crew-anim crew-body-idle">
          <line x1="50" y1="33" x2="50" y2="20" stroke="var(--line-strong)" strokeWidth="3" />
          <circle cx="50" cy="17" r="6" fill="var(--orb-task)" />
          <rect x="27" y="32" width="46" height="56" rx="23" className="crew-shell" />
          <rect x="33" y="45" width="34" height="22" rx="11" fill="var(--crew-visor)" />
          <circle cx="43" cy="56" r="4" fill={color} />
          <circle cx="57" cy="56" r="4" fill={color} />
        </g>
      </motion.svg>
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
