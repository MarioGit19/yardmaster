import {
  type ActivityEvent,
  type BoardState,
  type ClaudeSession,
  type Project,
  PULSE_WINDOW_MS,
  sessionDisplayName,
} from '@c-board/protocol';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cubicBezier } from 'motion';
import { AnimatePresence, motion } from 'motion/react';
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useLocation } from 'wouter';
import { useNow } from '../anim/clock.js';
import { type FrameHandle, frameScheduler } from '../anim/scheduler.js';
import { useBoard, useBoardStore } from '../data/index.js';
import { dur, ease, loop, moment, move, useMotionLevel } from '../motion.js';
import { ClaudeOrb } from '../orb/ClaudeOrb.js';
import { resolveColor } from '../orb/colors.js';
import { orbStateFor } from '../orb/model.js';
import { useMediaQuery, usePreference } from '../prefs.js';
import type { Tone } from '../status.js';
import { terminalTarget } from '../terminal/target.js';
import { applyTheme, useTheme } from '../theme/theme.js';
import { cx } from '../ui/cx.js';
import { NumberTicker } from '../ui/NumberTicker.js';
import { SegmentThumb, useSegmentThumb } from '../ui/SegmentThumb.js';
import {
  buildLanes,
  countSince,
  eventDetail,
  eventLabel,
  eventTone,
  FILTER_LABEL,
  formatAgo,
  hitTest,
  laneCenter,
  PULSE_FILTERS,
  type PulseDot,
  type PulseFilter,
  type PulseLane,
  type PulseLayout,
  placeDots,
  pulseHeight,
  pulseLayout,
  pulseSession,
  pulseTarget,
  stepDot,
  timeToX,
} from './model.js';
import {
  PULSE_COMPACT_QUERY,
  pulseCollapsed,
  pulseFilterPreference,
  pulsePreference,
  togglePulse,
} from './prefs.js';

/** How long a new dot takes to fly in from the right gutter. */
const FLY_MS = loop.fly * 1000;
/** Only events this fresh fly in; older arrivals (a backfill, a late batch) just appear. */
const FLY_MAX_AGE_MS = 10_000;
/** New dots keep a soft halo that fades over this long. */
const HALO_MS = 20_000;
/** The window slides about 1 px/s, so a redraw per second keeps it current. */
const DRIFT_MS = 1_000;
/** Runners on the collapsed rail at once; a burst beyond this drops the extras. */
const MAX_RUNNERS = 6;
/** How far a runner travels in from the right edge, px (at most this share of the rail). */
const RUN_PX = 520;
const RUN_SHARE = 0.4;
/** Lanes visible before the rail scrolls. */
const MAX_VISIBLE_LANES = 6;
const LABEL_FONT = '500 11px "Geist Mono Variable", ui-monospace, monospace';

const easeOut = cubicBezier(...ease.out);
const TONE_VAR: Record<Tone, string> = {
  work: 'var(--st-work)',
  tool: 'var(--st-tool)',
  wait: 'var(--st-wait)',
  ok: 'var(--st-ok)',
  err: 'var(--st-err)',
  idle: 'var(--st-idle)',
};
const rgba = (value: string, alpha: number) => {
  const [r, g, b] = resolveColor(value);
  return `rgb(${r} ${g} ${b} / ${alpha})`;
};

const tokenCache = new Map<string, string>();

/**
 * A token's computed value, alpha included (the hairline tokens are translucent). Read once per
 * applied theme, like `resolveColor`, so a redraw never recalculates styles.
 */
function token(name: string): string {
  const key = `${document.documentElement.dataset.theme ?? 'dark'}|${name}`;
  let value = tokenCache.get(key);
  if (value === undefined) {
    value =
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'transparent';
    tokenCache.set(key, value);
  }
  return value;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let end = text.length;
  while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > max) end--;
  return `${text.slice(0, end)}…`;
}

/** Truncated lane names by width, so only a new name or label width measures text. */
const labelCache = new Map<string, string>();

function laneLabel(ctx: CanvasRenderingContext2D, name: string, max: number): string {
  const key = `${max}|${name}`;
  let label = labelCache.get(key);
  if (label === undefined) {
    if (labelCache.size > 256) labelCache.clear();
    ctx.font = LABEL_FONT;
    label = truncate(ctx, name, max);
    labelCache.set(key, label);
  }
  return label;
}

/** Errors are diamonds and waits are rings, so the type reads without color (DESIGN.md §8). */
function drawMark(ctx: CanvasRenderingContext2D, dot: PulseDot, x: number, scale: number) {
  const { y, tone } = dot;
  ctx.beginPath();
  if (tone === 'err') {
    const r = 4 * scale;
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
  } else if (tone === 'wait') {
    ctx.arc(x, y, 3.25 * scale, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    ctx.arc(x, y, 3 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Everything the plot draws that only changes with the data, the filter, the width or the
 * once-a-second drift. Frames during a fly-in reuse it and only ease the flying dots.
 */
interface Scene {
  activity: readonly ActivityEvent[];
  projects: BoardState['projects'];
  filter: PulseFilter;
  width: number;
  now: number;
  layout: PulseLayout;
  lanes: PulseLane[];
  labels: string[];
  ticks: { minutes: number; x: number }[];
  /** Oldest first, so new dots draw on top. */
  dots: PulseDot[];
  /** Each lane's newest dot: only these glow, so bursts don't pile up into a blob. */
  newest: Set<PulseDot>;
}

/**
 * The bottom activity timeline, DESIGN.md §4.7: the last 15 minutes, one lane per project,
 * one dot per event colored by type. Everything inside the plot is drawn on one canvas.
 */
export function PulseRail() {
  const collapsed = pulseCollapsed(
    usePreference(pulsePreference),
    useMediaQuery(PULSE_COMPACT_QUERY),
  );
  // The store keeps the last hour (Transit's map); the rail counts its own 15 minutes.
  const now = useNow(DRIFT_MS);
  const count = useBoard((s) => countSince(s.activity, now - PULSE_WINDOW_MS));

  return (
    <section
      aria-label="Pulse"
      data-pulse={collapsed ? 'collapsed' : 'expanded'}
      className="relative shrink-0 border-line border-t bg-bg-1"
    >
      {collapsed && <PulseTicker />}
      <div className="flex h-9 items-center gap-3 px-3 touch:h-11">
        <button
          type="button"
          onClick={togglePulse}
          aria-expanded={!collapsed}
          className="flex h-7 items-center gap-2 rounded-control px-1.5 text-label text-text-2 transition-colors duration-fast hover:text-text-1 touch:h-11"
        >
          {collapsed ? (
            <ChevronUp className="size-4" strokeWidth={1.5} />
          ) : (
            <ChevronDown className="size-4" strokeWidth={1.5} />
          )}
          <span className="font-medium text-text-1">Pulse</span>
          <span className="tabular hidden text-text-2 sm:inline">
            <NumberTicker value={count} /> {count === 1 ? 'event' : 'events'} · 15 min
          </span>
        </button>
        {!collapsed && <FilterToggle />}
      </div>
      {/* Collapsing fades the plot out before it goes, rather than snapping it away. */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="plot"
            exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
          >
            <PulsePlot />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/**
 * The collapsed rail keeps talking: each new event sends a small dot in its tone along the top
 * hairline, in from the right like the plot's dots. Reduced fades it in place; Off shows nothing.
 */
function PulseTicker() {
  const store = useBoardStore();
  const level = useMotionLevel();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = ref.current;
    if (!track || level === 'off') return;
    const known = new Set(store.getState().activity.map((e) => e.id));
    const running = new Set<Animation>();
    let runs = 0;

    const launch = (event: ActivityEvent) => {
      if (running.size >= MAX_RUNNERS || document.hidden) return;
      const width = track.clientWidth;
      if (width === 0) return;
      const dot = document.createElement('span');
      dot.className = 'pulse-runner';
      dot.dataset.pulseRunner = eventTone(event);
      dot.style.setProperty('--runner', TONE_VAR[eventTone(event)]);
      track.append(dot);
      dot.style.left = `${width - 6}px`;
      const still = level !== 'full';
      const travel = Math.min(RUN_PX, width * RUN_SHARE);
      const run = dot.animate(
        [
          { transform: move(still, 'translateX(0)'), opacity: 0 },
          { opacity: 1, offset: 0.12 },
          { opacity: 1, offset: 0.55 },
          { transform: move(still, `translateX(${-travel}px)`), opacity: 0 },
        ],
        { duration: moment.spark * 1000, easing: `cubic-bezier(${ease.out.join(',')})` },
      );
      running.add(run);
      track.dataset.runs = String(++runs);
      const done = () => {
        running.delete(run);
        dot.remove();
      };
      run.onfinish = done;
      run.oncancel = done;
    };

    const off = store.subscribe((state, prev) => {
      if (state.activity === prev.activity) return;
      const now = Date.now();
      const fresh: ActivityEvent[] = [];
      for (const event of state.activity as ActivityEvent[]) {
        if (!known.has(event.id) && now - event.ts < FLY_MAX_AGE_MS) fresh.push(event);
      }
      known.clear();
      for (const event of state.activity) known.add(event.id);
      for (const event of fresh.sort((a, b) => a.ts - b.ts)) launch(event);
    });
    return () => {
      off();
      for (const run of running) run.cancel();
    };
  }, [store, level]);

  return <div ref={ref} aria-hidden data-pulse-ticker className="pulse-ticker" />;
}

export function FilterToggle() {
  const filter = usePreference(pulseFilterPreference);
  const thumb = useSegmentThumb();
  return (
    <div
      role="radiogroup"
      aria-label="Show"
      className="ml-auto flex shrink-0 rounded-control bg-bg-2 p-0.5"
    >
      {PULSE_FILTERS.map((option) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={filter === option}
          data-filter={option}
          onClick={(e) => {
            thumb.pick(e);
            pulseFilterPreference.set(option);
          }}
          className={cx(
            'relative h-6 rounded-chip px-2 text-meta transition-colors duration-fast touch:h-11 touch:min-w-11',
            filter === option ? 'text-text-1' : 'text-text-3 hover:text-text-1',
          )}
        >
          {filter === option && (
            <SegmentThumb
              layoutId={thumb.layoutId}
              byKeyboard={thumb.byKeyboard}
              className="bg-bg-1"
            />
          )}
          <span className="relative">{FILTER_LABEL[option]}</span>
        </button>
      ))}
    </div>
  );
}

function PulsePlot() {
  const store = useBoardStore();
  const level = useMotionLevel();
  const { theme } = useTheme();
  const filter = usePreference(pulseFilterPreference);
  const [, navigate] = useLocation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [laneCount, setLaneCount] = useState(0);
  const [dotCount, setDotCount] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dpr] = useState(() => Math.min(2, window.devicePixelRatio || 1));
  const scene = useRef<Scene | null>(null);
  const arrivals = useRef(new Map<string, number>());
  const handle = useRef<FrameHandle | null>(null);

  const active = hovered ?? selected;
  const height = pulseHeight(laneCount);

  // Everything the draw reads that React owns; the frame loop reads it through a ref.
  const inputs = useRef({ width, filter, level, active, dpr });
  inputs.current = { width, filter, level, active, dpr };

  /**
   * Lays out lanes, labels and dots for the current data. Skipped when nothing it reads has
   * changed, unless `drift` asks for a new "now". Never runs from the frame loop.
   */
  const rebuild = useCallback(
    (drift: boolean) => {
      const ctx = canvasRef.current?.getContext('2d');
      const { width, filter } = inputs.current;
      if (!ctx || width === 0) return;
      const { board, activity } = store.getState();
      const prev = scene.current;
      if (
        !drift &&
        prev &&
        prev.activity === activity &&
        prev.projects === board.projects &&
        prev.filter === filter &&
        prev.width === width
      ) {
        return;
      }
      const now = Date.now();
      const lanes = buildLanes(activity, board.projects, filter, now - PULSE_WINDOW_MS);
      const layout = pulseLayout(width, lanes.length);
      const dots = placeDots(lanes, now, layout).sort((a, b) => a.event.ts - b.event.ts);
      const newestByLane = new Map(dots.map((dot) => [dot.lane, dot]));
      scene.current = {
        activity,
        projects: board.projects,
        filter,
        width,
        now,
        layout,
        lanes,
        labels: lanes.map((lane) => laneLabel(ctx, lane.name, layout.labelWidth - 24)),
        ticks: [15, 10, 5].map((minutes) => ({
          minutes,
          x: Math.round(timeToX(now - minutes * 60_000, now, layout)),
        })),
        dots,
        newest: new Set(newestByLane.values()),
      };
      setLaneCount(lanes.length);
      setDotCount(dots.length);
    },
    [store],
  );

  /** Paints one frame from the scene. Returns whether a dot is still flying in. */
  const draw = useCallback((): boolean => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const current = scene.current;
    const { level, active, dpr } = inputs.current;
    if (!canvas || !ctx || !current) return false;
    const { layout, lanes, labels, ticks, dots, newest, now } = current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, layout.width, layout.height);
    const line = token('--line');
    const activeDot = active ? dots.find((d) => d.event.id === active) : undefined;

    // Five-minute gridlines, the "now" line, and their labels.
    const axisY = layout.top + lanes.length * layout.laneHeight;
    const labelY = axisY + layout.axisHeight / 2;
    ctx.fillStyle = line;
    for (const { x } of ticks) ctx.fillRect(x, layout.top, 1, axisY - layout.top);
    ctx.fillStyle = token('--line-strong');
    ctx.fillRect(Math.round(layout.plotRight), layout.top, 1, axisY - layout.top);
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rgba('var(--text-3)', 1);
    for (const { minutes, x } of ticks) {
      ctx.textAlign = minutes === 15 ? 'left' : 'center';
      ctx.fillText(`−${minutes}m`, x, labelY);
    }
    ctx.textAlign = 'right';
    ctx.fillText('now', layout.plotRight + 4, labelY);

    // Lanes: accent dot, name, and a hairline track.
    ctx.textAlign = 'left';
    lanes.forEach((lane, index) => {
      const y = laneCenter(index, layout);
      ctx.fillStyle =
        lane.accent === null ? rgba('var(--text-3)', 1) : rgba(`var(--accent-${lane.accent})`, 1);
      ctx.beginPath();
      ctx.arc(14, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(activeDot?.lane === index ? 'var(--text-1)' : 'var(--text-2)', 1);
      ctx.fillText(labels[index] ?? '', 24, y);
      ctx.fillStyle = line;
      ctx.fillRect(layout.plotLeft, Math.round(y), layout.plotRight - layout.plotLeft, 1);
    });

    // Dots sit where the scene placed them; only the flying ones are eased each frame.
    const clock = performance.now();
    let flying = false;
    for (const dot of dots) {
      const color = TONE_VAR[dot.tone];
      const started = arrivals.current.get(dot.event.id);
      let t = 1;
      if (started !== undefined) {
        t = Math.min(1, (clock - started) / FLY_MS);
        if (t >= 1 || level === 'off') arrivals.current.delete(dot.event.id);
        else flying = true;
      }
      const e = t >= 1 || level === 'off' ? 1 : easeOut(t);
      // Full flies in from the gutter; Reduced only fades in.
      const x = level === 'full' && e < 1 ? dot.x + (layout.width + 4 - dot.x) * (1 - e) : dot.x;
      const alpha = level === 'full' ? Math.min(1, t * 3) : e;
      const age = now - dot.event.ts;
      if (age < HALO_MS && newest.has(dot)) {
        const glow = 0.35 * (1 - age / HALO_MS) * alpha;
        const halo = ctx.createRadialGradient(x, dot.y, 0, x, dot.y, 9);
        halo.addColorStop(0, rgba(color, glow));
        halo.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = halo;
        ctx.fillRect(x - 9, dot.y - 9, 18, 18);
      }
      if (level === 'full' && t < 1) {
        // A short comet tail behind the flying dot.
        const tail = 28 * (1 - e);
        const gradient = ctx.createLinearGradient(x, 0, x + tail, 0);
        gradient.addColorStop(0, rgba(color, 0.6));
        gradient.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = gradient;
        ctx.fillRect(x, dot.y - 1, tail, 2);
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = rgba(color, 1);
      ctx.strokeStyle = rgba(color, 1);
      drawMark(ctx, dot, x, level === 'full' ? 1 + 0.4 * (1 - e) : 1);
      ctx.globalAlpha = 1;
    }
    if (activeDot) {
      ctx.strokeStyle = rgba('var(--text-1)', 0.7);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(activeDot.x, activeDot.y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    return flying;
  }, []);

  const drawRef = useRef(draw);
  drawRef.current = draw;

  // One registration on the shared scheduler; it runs only while something is flying in.
  useEffect(() => {
    const h = frameScheduler().add(() => {
      if (!drawRef.current()) h.setActive(false);
    }, false);
    handle.current = h;
    return () => {
      h.remove();
      handle.current = null;
    };
  }, []);
  const invalidate = useCallback(() => handle.current?.setActive(true), []);

  // New events: remember when they arrived so they fly in, then redraw.
  useEffect(() => {
    const known = new Set(store.getState().activity.map((e) => e.id));
    const off = store.subscribe((state, prev) => {
      if (state.activity === prev.activity && state.board.projects === prev.board.projects) return;
      const now = Date.now();
      const clock = performance.now();
      const next = new Set<string>();
      for (const event of state.activity as ActivityEvent[]) {
        next.add(event.id);
        if (!known.has(event.id) && now - event.ts < FLY_MAX_AGE_MS) {
          arrivals.current.set(event.id, clock);
        }
      }
      known.clear();
      for (const id of next) known.add(id);
      rebuild(false);
      invalidate();
    });
    const redo = () => {
      rebuild(true);
      invalidate();
    };
    const timer = setInterval(redo, DRIFT_MS);
    void document.fonts?.ready.then(() => {
      // Labels measured with the fallback font are now the wrong length.
      labelCache.clear();
      redo();
    });
    return () => {
      off();
      clearInterval(timer);
    };
  }, [store, rebuild, invalidate]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => setWidth(scroller.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // Size the backing store, then draw synchronously so a resize never shows a blank frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw whenever a drawn input changes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    // useTheme applies a new theme in an effect, after this one; the tokens must match it now.
    applyTheme(document.documentElement, theme);
    rebuild(false);
    draw();
  }, [width, height, dpr, filter, level, active, theme, rebuild, draw]);

  const dotAt = (event: MouseEvent<HTMLCanvasElement>) => {
    const current = scene.current;
    if (!current) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    return hitTest(
      current.dots,
      event.clientX - rect.left,
      event.clientY - rect.top,
      current.layout,
    );
  };

  const open = (id: string | null) => {
    const dot = scene.current?.dots.find((d) => d.event.id === id);
    if (!dot) return;
    const target = pulseTarget(dot.event, store.getState().board);
    if (!target) return;
    if (target.terminal) terminalTarget.set(target.terminal);
    navigate(target.href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter' || event.key === ' ') {
      if (selected === null) return;
      event.preventDefault();
      open(selected);
      return;
    }
    if (event.key === 'Escape') {
      if (selected === null) return;
      event.preventDefault();
      setSelected(null);
      return;
    }
    const next = stepDot(scene.current?.dots ?? [], selected, event.key);
    if (next === undefined) return;
    event.preventDefault();
    setSelected(next);
  };

  const activeDot = scene.current?.dots.find((d) => d.event.id === active) ?? null;
  const visibleHeight = pulseHeight(Math.min(Math.max(1, laneCount), MAX_VISIBLE_LANES));
  const empty = width > 0 && dotCount === 0;

  return (
    <div className="pulse-body relative px-1 pb-1">
      <div
        ref={scrollerRef}
        role="application"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: one composite widget, driven by arrow keys
        tabIndex={0}
        aria-label="Activity timeline, last 15 minutes. Use the arrow keys to move between events and Enter to open one."
        aria-roledescription="timeline"
        onKeyDown={onKeyDown}
        onBlur={() => setSelected(null)}
        style={{ maxHeight: visibleHeight }}
        className="overflow-y-auto overflow-x-hidden rounded-control outline-none"
      >
        <canvas
          ref={canvasRef}
          aria-hidden
          data-pulse-canvas
          data-lanes={laneCount}
          data-dots={dotCount}
          onPointerMove={(event) => setHovered(dotAt(event)?.event.id ?? null)}
          onPointerLeave={() => setHovered(null)}
          onClick={(event) => open(dotAt(event)?.event.id ?? null)}
          className={cx('block', hovered !== null && 'cursor-pointer')}
        />
      </div>
      {empty && (
        <p className="pointer-events-none absolute inset-x-0 top-1 text-center text-label text-text-3">
          No matching activity in the last 15 minutes
        </p>
      )}
      {activeDot && (
        <PulseTooltip
          dot={activeDot}
          project={store.getState().board.projects[activeDot.event.projectId ?? '']}
          session={pulseSession(activeDot.event, store.getState().board)}
          scrollTop={scrollerRef.current?.scrollTop ?? 0}
          width={width}
        />
      )}
      <div aria-live="polite" className="sr-only">
        {selected !== null && activeDot ? describe(activeDot.event) : ''}
      </div>
    </div>
  );
}

function describe(event: ActivityEvent): string {
  const detail = eventDetail(event);
  const summary = detail ? `: ${detail}` : '';
  return `${eventLabel(event)}${summary}, ${formatAgo(Date.now() - event.ts)}`;
}

function PulseTooltip({
  dot,
  project,
  session,
  scrollTop,
  width,
}: {
  dot: PulseDot;
  project: Project | undefined;
  /** Its session, or the one in its terminal: shown by orb and title, not process name. */
  session: ClaudeSession | undefined;
  scrollTop: number;
  width: number;
}) {
  const { event } = dot;
  // Kept inside the rail horizontally; it sits above the dot.
  const half = Math.min(140, width / 2);
  const left = Math.min(Math.max(dot.x + 4, half + 4), width + 4 - half);
  return (
    <div
      role="tooltip"
      data-pulse-tooltip
      data-x={Math.round(dot.x)}
      data-y={Math.round(dot.y - scrollTop)}
      style={{ left, top: dot.y - scrollTop }}
      className="pointer-events-none absolute z-20 w-max max-w-70 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-control border border-line bg-bg-2 px-3 py-1.5 text-label shadow-raised"
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: TONE_VAR[dot.tone] }}
        />
        <span className="font-medium text-text-1">{eventLabel(event)}</span>
        <span className="tabular text-text-2">{formatAgo(Date.now() - event.ts)}</span>
      </div>
      {eventDetail(event) && (
        <p className="mt-0.5 line-clamp-2 break-words font-mono text-meta text-text-2">
          {eventDetail(event)}
        </p>
      )}
      {session && (
        <p
          data-pulse-session
          className="mt-1 flex min-w-0 items-center gap-1.5 text-meta text-text-1"
        >
          <span aria-hidden className="flex shrink-0">
            <ClaudeOrb
              state={orbStateFor(session.status)}
              size={12}
              accent={`var(--accent-${project?.accent ?? 0})`}
            />
          </span>
          <span className="truncate">{sessionDisplayName(session)}</span>
        </p>
      )}
      {project && <p className="mt-0.5 text-meta text-text-2">{project.name}</p>}
    </div>
  );
}
