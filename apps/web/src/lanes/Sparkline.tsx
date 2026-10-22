import { useLayoutEffect, useRef, useState } from 'react';
import { useInView } from '../anim/useFrame.js';
import { useMotionLevel } from '../motion.js';
import { resolveColor } from '../orb/colors.js';
import { applyTheme, useTheme } from '../theme/theme.js';
import { cx } from '../ui/cx.js';
import { HEAD_ROOM, sparkPoints, sparkStep } from './spark.js';
import { SAMPLE_MS, SAMPLES, type SampleRing } from './throughput.js';
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
 * The lane's 60-sample output-rate line, DESIGN.md §4.3: a soft fill in the lane's color under
 * the line, and a bright head on the newest sample while the terminal writes. It redraws once per
 * sample, and a linear one-step slide on the compositor brings each new sample in from the right.
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
    const [r, g, b] = resolveColor(tint);
    const { width, height } = size;
    // The plot stops short of the right edge, so the head dot isn't clipped once it slides in.
    const plot = Math.max(1, width - HEAD_ROOM);
    const step = sparkStep(plot);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width + step, height);

    const points = sparkPoints(ring, plot, height, HEAD_ROOM / 2);
    const quiet = ring.max() === 0;
    trace(ctx, points);
    if (!quiet) {
      ctx.save();
      ctx.lineTo(plot + step, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, 0, 0, height);
      fill.addColorStop(0, `rgb(${r} ${g} ${b} / 0.38)`);
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

    // Streaming: a bright head with a soft halo on the newest sample.
    const head = points[SAMPLES - 1];
    if (head && ring.at(SAMPLES - 1) > 0) {
      const [x, y] = head;
      const halo = ctx.createRadialGradient(x, y, 0, x, y, HEAD_ROOM);
      halo.addColorStop(0, `rgb(${r} ${g} ${b} / 0.55)`);
      halo.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`);
      ctx.fillStyle = halo;
      ctx.fillRect(x - HEAD_ROOM, y - HEAD_ROOM, HEAD_ROOM * 2, HEAD_ROOM * 2);
      ctx.beginPath();
      ctx.arc(x, y, 1.75, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${Math.round((r + 255) / 2)} ${Math.round((g + 255) / 2)} ${Math.round((b + 255) / 2)})`;
      ctx.fill();
    }

    slide.current?.cancel();
    slide.current = null;
    if (animate && !quiet && typeof canvas.animate === 'function') {
      slide.current = canvas.animate(
        // motion-still: only `animate` (Full) slides; still sparklines take the branch below.
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

  // useTheme applies a new theme in an effect, after the redraw below; the colors the draw
  // resolves must already match it. Once per theme change, not per sample.
  useLayoutEffect(() => applyTheme(document.documentElement, theme), [theme]);

  // Size, color, theme or motion changed, or the sparkline came back on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw whenever any drawn input changes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;
    const step = sparkStep(Math.max(1, size.width - HEAD_ROOM));
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
      className={cx('relative block h-6 min-w-0 overflow-hidden', className)}
    >
      <canvas ref={canvasRef} className="absolute top-0 left-0" />
    </span>
  );
}
