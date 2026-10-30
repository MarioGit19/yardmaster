import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useInView } from '../anim/useFrame.js';
import { useMotionLevel } from '../motion.js';
import { resolveColor } from '../orb/colors.js';
import { applyTheme, useTheme } from '../theme/theme.js';
import { cx } from '../ui/cx.js';
import {
  CPU_WINDOW_MS,
  cpuPoints,
  HEAD_ROOM,
  type LaneSignal,
  laneSignal,
  OUTPUT_WINDOW_MS,
  outputTicks,
  sameSignal,
  sparkStep,
  windowLabel,
} from './spark.js';
import { CPU_SAMPLE_EVERY, SAMPLE_MS, type SampleRing } from './throughput.js';
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
  /** A command is running: a flat series then shows its CPU as text, not nothing. */
  running?: boolean;
  className?: string;
}

const NONE: LaneSignal = { kind: 'none' };

function describe(signal: LaneSignal): string | undefined {
  if (signal.kind === 'line') return `CPU ${signal.cpu}%, over the last 5 minutes`;
  if (signal.kind === 'ticks') return 'Output in the last minute';
  if (signal.kind === 'value') return `CPU ${signal.cpu}%`;
  return undefined;
}

/**
 * The lane's activity track, DESIGN.md §4.3. It draws only what says something: a CPU line on a
 * fixed 0–100 % axis when the CPU moved in its window, otherwise output as a tick strip, otherwise
 * the CPU as text, and nothing when the terminal is idle. A graph redraws once per sample, and a
 * linear one-step slide on the compositor brings each new sample in from the right.
 */
export function Sparkline({
  terminalId,
  color,
  error = false,
  running = false,
  className,
}: SparklineProps) {
  const { theme } = useTheme();
  const level = useMotionLevel();
  const rootRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<SampleRing | null>(null);
  const cpuRef = useRef<SampleRing | null>(null);
  const drawnCpu = useRef(-1);
  const slide = useRef<Animation | null>(null);
  const inView = useInView(rootRef);
  const [signal, setSignal] = useState<LaneSignal>(NONE);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [dpr] = useState(() =>
    Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1),
  );
  const graphed = signal.kind === 'line' || signal.kind === 'ticks';

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

  const draw = (animate: boolean, kind: LaneSignal['kind']) => {
    const canvas = canvasRef.current;
    const ring = ringRef.current;
    const cpu = cpuRef.current;
    if (!canvas || !ring || !cpu || !size || size.width === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const [r, g, b] = resolveColor(tint);
    const { width, height } = size;
    // The plot stops short of the right edge, so the end dot isn't clipped once it slides in.
    const plot = Math.max(1, width - HEAD_ROOM);
    const step = sparkStep(plot);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width + step, height);

    if (kind === 'ticks') {
      ctx.fillStyle = `rgb(${r} ${g} ${b} / 0.85)`;
      for (const tick of outputTicks(ring, plot, height)) {
        ctx.fillRect(tick.x, height - tick.height, 1, tick.height);
      }
    } else if (kind === 'line') {
      const points = cpuPoints(cpu, plot, height, HEAD_ROOM / 2);
      const first = points[0];
      const head = points.at(-1);
      if (first && head) {
        trace(ctx, points);
        ctx.save();
        ctx.lineTo(head[0], height);
        ctx.lineTo(first[0], height);
        ctx.closePath();
        const fill = ctx.createLinearGradient(0, 0, 0, height);
        fill.addColorStop(0, `rgb(${r} ${g} ${b} / 0.38)`);
        fill.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.restore();
        trace(ctx, points);
        ctx.lineWidth = 1.25;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = `rgb(${r} ${g} ${b} / 0.95)`;
        ctx.stroke();

        // The end dot sits on the current value, a soft halo around it.
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
    }

    slide.current?.cancel();
    slide.current = null;
    if (animate && kind !== 'none' && typeof canvas.animate === 'function') {
      slide.current = canvas.animate(
        // motion-still: only `animate` (Full) slides; still graphs take the branch below.
        [{ transform: 'translateX(0)' }, { transform: `translateX(${-step}px)` }],
        {
          duration: SAMPLE_MS * (kind === 'line' ? CPU_SAMPLE_EVERY : 1),
          easing: 'linear',
          fill: 'forwards',
        },
      );
    } else {
      // Still graphs show the newest sample at the right edge.
      canvas.style.transform = `translateX(${-step}px)`;
    }
  };

  const drawRef = useRef(draw);
  drawRef.current = draw;
  const live = useRef({ inView, moving: level === 'full', running, signal });
  live.current = { inView, moving: level === 'full', running, signal };

  const read = useCallback((ring: SampleRing, cpu: SampleRing) => {
    const next = laneSignal(ring, cpu, live.current.running);
    if (!sameSignal(next, live.current.signal)) {
      live.current.signal = next;
      setSignal(next);
    }
    return next;
  }, []);

  useThroughput(terminalId, (ring, cpu) => {
    ringRef.current = ring;
    cpuRef.current = cpu;
    const next = read(ring, cpu);
    // The line's samples come every few seconds; only a new one moves it.
    if (next.kind === 'line' && cpu.count === drawnCpu.current) return;
    drawnCpu.current = cpu.count;
    if (live.current.inView) drawRef.current(live.current.moving, next.kind);
  });

  // A command starting or ending can change the text without a new sample.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` sees `running` through a ref.
  useLayoutEffect(() => {
    if (ringRef.current && cpuRef.current) read(ringRef.current, cpuRef.current);
  }, [running, read]);

  // useTheme applies a new theme in an effect, after the redraw below; the colors the draw
  // resolves must already match it. Once per theme change, not per sample.
  useLayoutEffect(() => applyTheme(document.documentElement, theme), [theme]);

  // Size, color, theme, motion or the kind of graph changed, or it came back on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw whenever any drawn input changes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;
    const step = sparkStep(Math.max(1, size.width - HEAD_ROOM));
    canvas.width = Math.round((size.width + step) * dpr);
    canvas.height = Math.round(size.height * dpr);
    canvas.style.width = `${size.width + step}px`;
    canvas.style.height = `${size.height}px`;
    if (inView) drawRef.current(false, signal.kind);
  }, [size, dpr, tint, theme, level, inView, signal.kind]);

  useLayoutEffect(() => () => slide.current?.cancel(), []);

  const cpu = signal.kind === 'line' || signal.kind === 'value' ? signal.cpu : null;
  const label = describe(signal);

  return (
    <span
      role="img"
      aria-label={label ?? 'No recent activity'}
      title={label}
      data-sparkline={signal.kind}
      className={cx('lane-signal', className)}
    >
      <span ref={rootRef} className={cx('lane-signal-graph', !graphed && 'hidden')}>
        <canvas ref={canvasRef} className="absolute top-0 left-0" />
      </span>
      {graphed && (
        <span aria-hidden className="lane-signal-window">
          {windowLabel(signal.kind === 'line' ? CPU_WINDOW_MS : OUTPUT_WINDOW_MS)}
        </span>
      )}
      {cpu !== null && (
        <span aria-hidden className="lane-signal-value">
          {cpu}%
        </span>
      )}
    </span>
  );
}
