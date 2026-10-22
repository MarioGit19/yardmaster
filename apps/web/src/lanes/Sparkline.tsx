import { useLayoutEffect, useRef, useState } from 'react';
import { useInView } from '../anim/useFrame.js';
import { useMotionLevel } from '../motion.js';
import { resolveColor } from '../orb/colors.js';
import { applyTheme, useTheme } from '../theme/theme.js';
import { cx } from '../ui/cx.js';
import { sparkPoints, sparkStep } from './spark.js';
import { SAMPLE_MS, type SampleRing } from './throughput.js';
import { useThroughput } from './useThroughput.js';

function trace(ctx: CanvasRenderingContext2D, points: ReadonlyArray<[number, number]>) {
  ctx.beginPath();
  for (const [i, [x, y]] of points.entries()) {
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

export interface SparklineProps {
  terminalId: string;
  /** The project accent, e.g. `var(--accent-3)`. */
  color: string;
  /** Rose instead of the accent, for a lane whose last command failed. */
  error?: boolean;
  className?: string;
}

/**
 * The lane's 60-sample output-rate line, DESIGN.md §4.3. It redraws once per sample, and a
 * linear one-step slide on the compositor brings each new sample in from the right.
 */
export function Sparkline({ terminalId, color, error = false, className }: SparklineProps) {
  const { theme } = useTheme();
  const level = useMotionLevel();
  const rootRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<SampleRing | null>(null);
  const slide = useRef<Animation | null>(null);
  const inView = useInView(rootRef);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [dpr] = useState(() =>
    Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1),
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      // Layout size, not the painted box: a scaling ancestor (the focus morph) mustn't squash it.
      const width = root.offsetWidth;
      const height = root.offsetHeight;
      setSize((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const tint = error ? 'var(--st-err)' : color;

  const draw = (animate: boolean) => {
    const canvas = canvasRef.current;
    const ring = ringRef.current;
    if (!canvas || !ring || !size || size.width === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (typeof document !== 'undefined') applyTheme(document.documentElement, theme);
    const [r, g, b] = resolveColor(tint);
    const { width, height } = size;
    const step = sparkStep(width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width + step, height);

    const points = sparkPoints(ring, width, height);
    const quiet = ring.max() === 0;
    trace(ctx, points);
    if (!quiet) {
      ctx.save();
      ctx.lineTo(width + step, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, 0, 0, height);
      fill.addColorStop(0, `rgb(${r} ${g} ${b} / 0.24)`);
      fill.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.restore();
      trace(ctx, points);
    }
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgb(${r} ${g} ${b} / ${quiet ? 0.35 : 0.95})`;
    ctx.stroke();

    slide.current?.cancel();
    slide.current = null;
    if (animate && !quiet && typeof canvas.animate === 'function') {
      slide.current = canvas.animate(
        [{ transform: 'translateX(0)' }, { transform: `translateX(${-step}px)` }],
        { duration: SAMPLE_MS, easing: 'linear', fill: 'forwards' },
      );
    } else {
      // Still sparklines show the newest sample at the right edge.
      canvas.style.transform = `translateX(${-step}px)`;
    }
  };

  const drawRef = useRef(draw);
  drawRef.current = draw;
  const live = useRef({ inView, moving: level === 'full' });
  live.current = { inView, moving: level === 'full' };

  useThroughput(terminalId, (ring) => {
    ringRef.current = ring;
    if (live.current.inView) drawRef.current(live.current.moving);
  });

  // Size, color, theme or motion changed, or the sparkline came back on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw whenever any drawn input changes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;
    const step = sparkStep(size.width);
    canvas.width = Math.round((size.width + step) * dpr);
    canvas.height = Math.round(size.height * dpr);
    canvas.style.width = `${size.width + step}px`;
    canvas.style.height = `${size.height}px`;
    if (inView) drawRef.current(false);
  }, [size, dpr, tint, theme, level, inView]);

  useLayoutEffect(() => () => slide.current?.cancel(), []);

  return (
    <span
      ref={rootRef}
      aria-hidden
      data-sparkline
      className={cx('relative block h-5 min-w-0 overflow-hidden', className)}
    >
      <canvas ref={canvasRef} className="absolute top-0 left-0" />
    </span>
  );
}
