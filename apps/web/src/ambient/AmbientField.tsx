import { useEffect, useRef, useState } from 'react';
import { useBoardStore } from '../data/index.js';
import { useWebglClaimed } from '../fx/webglSlot.js';
import { useMotionLevel } from '../motion.js';
import { selectPodOrder } from '../pod/model.js';
import { usePreference } from '../prefs.js';
import { projectHref } from '../routes.js';
import { useTheme } from '../theme/theme.js';
import { ambientOverride } from './debug.js';
import { grainUrl } from './grain.js';
import { FIELD_PALETTES } from './renderer.js';
import {
  AttentionPoint,
  activeSessionCount,
  approach,
  attentionProjectId,
  boardActivity,
  DEFAULT_ATTENTION_POINT,
  energyFrom,
  frameDue,
  ThroughputMeter,
  totalOutputBytes,
  viewportPoint,
} from './signal.js';
import {
  AMBIENT_RESOLUTION,
  type AmbientStyle,
  ambientStylePreference,
  createAmbientRenderer,
} from './style.js';

const FPS = 30;
const SAMPLE_MS = 250;
/** Smoothing time constants, ms: the room drifts, it never snaps. */
const TAU = { energy: 1400, attention: 900, position: 450 };

interface Target {
  energy: number;
  attention: number;
  x: number;
  y: number;
}

/** The on-screen element of the waiting project: its pod first, else its rail link. */
function attentionElement(projectId: string): Element | null {
  return (
    document.querySelector(`[data-pod="${CSS.escape(projectId)}"]`) ??
    document.querySelector(`a[href="#${CSS.escape(projectHref(projectId))}"]`)
  );
}

/**
 * The full-viewport background, DESIGN.md §4.1. Full motion runs a WebGL shader (0.5× DPR,
 * 30 fps, paused while hidden) in the chosen style (Nebula, Veil or Aurora); Reduced and Off, no
 * WebGL, or an fx effect holding the WebGL slot show a static CSS field whose energy and attention
 * only cross-fade. The None style shows the bare page.
 */
export function AmbientField() {
  const level = useMotionLevel();
  const { theme } = useTheme();
  const store = useBoardStore();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const target = useRef<Target>({ energy: 0, attention: 0, ...DEFAULT_ATTENTION_POINT });
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const style = usePreference(ambientStylePreference);
  // An fx effect with its own WebGL context is on screen: one context at a time (§7).
  const displaced = useWebglClaimed();
  const [failed, setFailed] = useState<ReadonlySet<AmbientStyle>>(() => new Set());
  const [ready, setReady] = useState(false);
  const [grain, setGrain] = useState<string | null>(null);
  const shader = style === 'none' ? null : style;
  const useWebgl = level === 'full' && shader !== null && !failed.has(shader) && !displaced;

  useEffect(() => {
    let live = true;
    void grainUrl().then((url) => live && setGrain(url));
    return () => {
      live = false;
    };
  }, []);

  // Samples the board a few times a second into `target` and the CSS field's variables.
  useEffect(() => {
    const meter = new ThroughputMeter();
    // The waiting pod's position is cached; only these, or a reorder, can move it.
    const attentionPoint = new AttentionPoint<Element>();
    const moved = () => attentionPoint.invalidate();
    const sample = () => {
      const { board, pulses } = store.getState();
      const override = ambientOverride.get();
      const rate = meter.sample(totalOutputBytes(board), performance.now());
      const energy =
        override.energy ??
        energyFrom(activeSessionCount(board), boardActivity(board, pulses, Date.now()), rate);
      const projectId = attentionProjectId(board);
      const element = projectId === null ? null : attentionElement(projectId);
      const order = projectId === null ? '' : selectPodOrder(store.getState()).join(' ');
      const point = attentionPoint.read(element, order, performance.now(), (target) =>
        viewportPoint(target.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
      const attention = (override.attention ?? projectId !== null) ? 1 : 0;
      target.current = { energy, attention, ...point };

      // Written only on change, so a steady board never invalidates the field's styles.
      const style = rootRef.current?.style;
      const write = (name: string, value: string) => {
        if (style && style.getPropertyValue(name) !== value) style.setProperty(name, value);
      };
      write('--ambient-energy', energy.toFixed(2));
      write('--ambient-attention', String(attention));
      write('--ambient-x', `${(point.x * 100).toFixed(1)}%`);
      write('--ambient-y', `${(point.y * 100).toFixed(1)}%`);
    };
    sample();
    const timer = setInterval(() => {
      if (!document.hidden) sample();
    }, SAMPLE_MS);
    const unsubscribe = ambientOverride.subscribe(sample);
    const resized = () => {
      moved();
      sample();
    };
    window.addEventListener('resize', resized);
    window.addEventListener('scroll', moved, { capture: true, passive: true });
    return () => {
      clearInterval(timer);
      unsubscribe();
      window.removeEventListener('resize', resized);
      window.removeEventListener('scroll', moved, { capture: true });
    };
  }, [store]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!useWebgl || !shader || !canvas) return;
    const markFailed = () => setFailed((set) => new Set(set).add(shader));
    const renderer = createAmbientRenderer(shader, canvas);
    if (!renderer) {
      markFailed();
      return;
    }

    const current = { ...target.current };
    let time = 0;
    let lastFrameAt: number | null = null;
    let raf = 0;
    let shown = false;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!frameDue(lastFrameAt, now, FPS)) return;
      // Clamped so a long stall (a busy main thread) never lurches the field forward.
      const dt = lastFrameAt === null ? 0 : Math.min(100, now - lastFrameAt);
      lastFrameAt = now;
      const goal = target.current;
      current.energy = approach(current.energy, goal.energy, dt, TAU.energy);
      current.attention = approach(current.attention, goal.attention, dt, TAU.attention);
      current.x = approach(current.x, goal.x, dt, TAU.position);
      current.y = approach(current.y, goal.y, dt, TAU.position);
      // Integrating speed (not scaling time) keeps the flow continuous as energy changes.
      time += (dt / 1000) * (0.012 + 0.11 * current.energy);
      const scale = (window.devicePixelRatio || 1) * AMBIENT_RESOLUTION[shader];
      renderer.draw({
        width: Math.max(1, Math.round(window.innerWidth * scale)),
        height: Math.max(1, Math.round(window.innerHeight * scale)),
        time,
        energy: current.energy,
        attention: current.attention,
        attentionX: current.x,
        attentionY: current.y,
        palette: FIELD_PALETTES[themeRef.current],
      });
      if (!shown) {
        shown = true;
        setReady(true);
      }
    };

    const start = () => {
      if (raf || document.hidden) return;
      lastFrameAt = null;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onLost = (event: Event) => {
      event.preventDefault();
      stop();
      markFailed();
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    canvas.addEventListener('webglcontextlost', onLost);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      renderer.dispose();
      setReady(false);
    };
  }, [useWebgl, shader]);

  if (shader === null) {
    return (
      <div
        ref={rootRef}
        aria-hidden
        data-ambient="none"
        className="pointer-events-none fixed inset-0 -z-10"
      />
    );
  }
  return (
    <div
      ref={rootRef}
      aria-hidden
      data-ambient={useWebgl ? 'webgl' : 'css'}
      data-ambient-style={shader}
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      <div className="ambient-css absolute inset-0" />
      <div className="ambient-attention absolute inset-0" />
      {useWebgl && (
        <canvas
          key={shader}
          ref={canvasRef}
          data-ready={ready || undefined}
          className="ambient-canvas absolute inset-0 size-full"
        />
      )}
      {grain && (
        <div
          className="ambient-grain absolute inset-0"
          style={{ backgroundImage: `url(${grain})` }}
        />
      )}
    </div>
  );
}
