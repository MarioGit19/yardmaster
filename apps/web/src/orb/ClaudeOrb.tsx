import { type ToolFamily, toolFamily } from '@c-board/protocol';
import { AnimatePresence, motion } from 'motion/react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useInView } from '../anim/useFrame.js';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
import { applyTheme, useTheme } from '../theme/theme.js';
import { cx } from '../ui/cx.js';
import { resolveColor } from './colors.js';
import {
  countdownProgress,
  EFFECT_DURATION,
  enterEffect,
  FAMILY_TOKEN,
  MAX_SATELLITES,
  type OrbEffect,
  type OrbState,
  orbAnimates,
  orbLabel,
  particleCount,
} from './model.js';
import { CANVAS_SCALE, drawOrb, type OrbFrame, type OrbPalette } from './render.js';

const STATUS_TOKEN: Record<OrbState, string> = {
  idle: '--st-idle',
  working: '--st-work',
  tool: '--st-tool',
  waiting: '--st-wait',
  error: '--st-err',
  compacting: '--st-work',
  ended: '--st-idle',
};

export interface ClaudeOrbProps {
  state: OrbState;
  /** CSS px, 28–64 in session rows and headers. */
  size?: number;
  /** The session's identity color, e.g. `var(--accent-3)`. */
  accent?: string;
  /** The running tool's name, for particle color, count and the label chip. */
  tool?: string | null;
  family?: ToolFamily;
  /** Running subagents, drawn as satellites. */
  subagents?: number;
  /** Epoch ms; fills a ring around a waiting orb. */
  countdown?: { startedAt: number; endsAt: number } | null;
  /** Shows the tool-name chip beside the orb while a tool runs. */
  showToolLabel?: boolean;
  className?: string;
}

/**
 * The living Claude session sphere, DESIGN.md §4.2. Drawn on canvas through the shared frame
 * scheduler, and only while it is on screen and has something to animate.
 */
export function ClaudeOrb({
  state,
  size = 40,
  accent = 'var(--st-work)',
  tool = null,
  family,
  subagents = 0,
  countdown = null,
  showToolLabel = true,
  className,
}: ClaudeOrbProps) {
  const { theme } = useTheme();
  const level = useMotionLevel();
  const moving = level === 'full';
  const rootRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inView = useInView(rootRef);
  const satellites = Math.max(0, Math.min(MAX_SATELLITES, Math.floor(subagents)));
  const toolFamilyName = family ?? (tool ? toolFamily(tool) : 'other');
  const particles = particleCount(tool);

  // Per-instance clock offset so a board of orbs never swirls in unison.
  const [offset] = useState(() => Math.random() * 60);
  const clock = useRef({ mountedAt: performance.now(), stateAt: performance.now() });
  const effect = useRef<{ kind: OrbEffect; at: number } | null>(null);
  const [effectOn, setEffectOn] = useState(false);
  const previous = useRef<OrbState | null>(null);

  // Track entry into a state before drawing it, so the first frame already shows the effect.
  if (previous.current !== state) {
    const kind = enterEffect(previous.current, state);
    const now = performance.now();
    clock.current.stateAt = now;
    effect.current = kind && moving ? { kind, at: now } : null;
    previous.current = state;
  }
  const effectPending = effect.current !== null;
  if (effectPending !== effectOn) setEffectOn(effectPending);

  const palette = useMemo<OrbPalette | null>(() => {
    if (typeof document === 'undefined') return null;
    // useTheme applies the theme in an effect, after this render; tokens must already match it.
    applyTheme(document.documentElement, theme);
    return {
      status: resolveColor(`var(${STATUS_TOKEN[state]})`),
      accent: resolveColor(accent),
      family: resolveColor(`var(${FAMILY_TOKEN[toolFamilyName]})`),
      satellite: resolveColor(`var(${FAMILY_TOKEN.task})`),
      ok: resolveColor('var(--st-ok)'),
      base: resolveColor('var(--bg-0)'),
      light: theme === 'light',
    };
  }, [state, accent, toolFamilyName, theme]);

  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const extent = size * CANVAS_SCALE;
  const [dpr] = useState(() =>
    Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1),
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = Math.round(extent * dpr);
    canvas.height = Math.round(extent * dpr);
    ctxRef.current = canvas.getContext('2d');
  }, [extent, dpr]);

  const draw = (now: number) => {
    const ctx = ctxRef.current;
    if (!ctx || !palette) return;
    let current: OrbFrame['effect'] = null;
    const fx = effect.current;
    if (fx) {
      const time = (now - fx.at) / 1000;
      if (time < EFFECT_DURATION[fx.kind]) current = { kind: fx.kind, time };
      else {
        effect.current = null;
        setEffectOn(false);
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOrb(
      ctx,
      {
        state,
        size,
        time: moving ? offset + (now - clock.current.mountedAt) / 1000 : 0,
        stateTime: (now - clock.current.stateAt) / 1000,
        effect: current,
        particles,
        satellites,
        countdown: countdownProgress(countdown, Date.now()),
        moving,
      },
      palette,
    );
  };

  const animating = moving && (orbAnimates(state, satellites) || effectOn);
  useFrame(draw, { visible: inView, enabled: animating });

  // Still orbs draw once per change; a countdown still advances once a second.
  const drawRef = useRef(draw);
  drawRef.current = draw;
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw whenever any drawn input changes.
  useLayoutEffect(() => {
    if (animating) return;
    drawRef.current(performance.now());
    if (state !== 'waiting' || !countdown) return;
    const timer = setInterval(() => drawRef.current(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [animating, palette, state, size, satellites, countdown, moving, extent]);

  const label = orbLabel(state, tool, satellites);
  const chip = showToolLabel && state === 'tool' && tool ? tool : null;

  return (
    <span
      ref={rootRef}
      role="img"
      aria-label={label}
      title={label}
      data-orb={state}
      className={cx('relative inline-block shrink-0 align-middle', className)}
      style={{ width: size, height: size }}
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        className={cx(
          'pointer-events-none absolute',
          state === 'idle' && satellites === 0 && 'orb-breathe',
        )}
        style={{
          width: extent,
          height: extent,
          left: (size - extent) / 2,
          top: (size - extent) / 2,
          animationDelay: `${-offset}s`,
        }}
      />
      <AnimatePresence initial={false}>
        {chip && (
          <motion.span
            key={chip}
            aria-hidden
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -2, transition: { duration: dur.fast, ease: ease.out } }}
            transition={spring.snappy}
            className="pointer-events-none absolute top-1/2 left-full ml-1.5 -translate-y-1/2 whitespace-nowrap rounded-chip border border-line bg-bg-2 px-1.5 py-px font-mono text-meta text-text-2"
            style={{ borderColor: `rgb(${palette?.family.join(' ') ?? '128 128 128'} / 0.35)` }}
          >
            {chip}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
