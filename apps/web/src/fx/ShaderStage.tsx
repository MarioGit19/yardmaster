import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useFrame, useInView } from '../anim/useFrame.js';
import { useMotionLevel } from '../motion.js';
import { type Theme, useTheme } from '../theme/theme.js';
import { cx } from '../ui/cx.js';
import { releaseContext } from './gl.js';
import { useWebglClaim } from './webglSlot.js';

export interface StageFrame {
  /** Drawing-buffer size in device pixels. */
  width: number;
  height: number;
  /** Drawing-buffer pixels per CSS pixel. */
  ratio: number;
  /** Seconds since the previous frame; 0 for a still frame. */
  dt: number;
  /** Reduced motion: one frame that holds still, redrawn only when an input changes. */
  still: boolean;
  theme: Theme;
}

export interface StageEffect {
  draw(frame: StageFrame): void;
  dispose(): void;
}

export interface ShaderStageProps {
  /** Builds the effect once the context exists; null when it can't (the fallback shows). */
  create(gl: WebGL2RenderingContext): StageEffect | null;
  /** Frame-rate cap at Full. */
  fps?: number;
  /** Fraction of the device pixel ratio to render at. */
  resolution?: number;
  /** Device pixel ratio cap before `resolution` applies. */
  maxRatio?: number;
  /** A still (Reduced) frame is redrawn whenever this changes. */
  stillKey?: unknown;
  /** What shows at Off, without WebGL2, or after a context loss: a static CSS surface. */
  fallback?: ReactNode;
  className?: string;
  /** Overlay content above the canvas (labels, controls). */
  children?: ReactNode;
}

/**
 * The host for every fx WebGL background (DESIGN.md §3 "Third-party effects"). Full draws on the
 * shared rAF loop at an fps cap while on screen and the tab is visible; Reduced draws one still
 * frame; Off shows the static fallback and creates no context. While its context lives it holds
 * the WebGL slot, so the ambient field steps back to CSS and the page keeps one context.
 */
export function ShaderStage({
  create,
  fps = 30,
  resolution = 1,
  maxRatio = 1.5,
  stillKey,
  fallback,
  className,
  children,
}: ShaderStageProps) {
  const level = useMotionLevel();
  const { theme } = useTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visible = useInView(rootRef);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const live = level !== 'off' && !failed;
  const still = level !== 'full';
  useWebglClaim(live);

  const createRef = useRef(create);
  createRef.current = create;
  const effectRef = useRef<StageEffect | null>(null);
  const size = useRef({ width: 1, height: 1, ratio: 1 });
  const stillRef = useRef(still);
  stillRef.current = still;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const tuning = useRef({ resolution, maxRatio });
  tuning.current = { resolution, maxRatio };

  const drawStill = useCallback(
    () => effectRef.current?.draw({ ...size.current, dt: 0, still: true, theme: themeRef.current }),
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!live || !root || !canvas) return;
    let gl: WebGL2RenderingContext | null = null;
    let effect: StageEffect | null = null;
    let disposed = false;

    const resize = () => {
      const { resolution, maxRatio } = tuning.current;
      const ratio = Math.min(window.devicePixelRatio || 1, maxRatio) * resolution;
      const width = Math.max(1, Math.round(root.clientWidth * ratio));
      const height = Math.max(1, Math.round(root.clientHeight * ratio));
      size.current = { width, height, ratio };
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      if (effect && stillRef.current) drawStill();
    };
    // One frame late, so the ambient field has released its context after this stage's claim.
    const start = requestAnimationFrame(() => {
      if (disposed) return;
      try {
        gl = canvas.getContext('webgl2', {
          alpha: true,
          premultipliedAlpha: true,
          antialias: false,
          depth: false,
          stencil: false,
          powerPreference: 'low-power',
        });
      } catch {
        gl = null;
      }
      effect = gl ? createRef.current(gl) : null;
      if (!effect) {
        setFailed(true);
        return;
      }
      effectRef.current = effect;
      resize();
      setReady(true);
    });
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    const onLost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
    };
    canvas.addEventListener('webglcontextlost', onLost);
    return () => {
      disposed = true;
      cancelAnimationFrame(start);
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      effect?.dispose();
      effectRef.current = null;
      if (gl) releaseContext(gl);
      setReady(false);
    };
  }, [live, drawStill]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed input redraws the still frame.
  useEffect(() => {
    if (ready && still) drawStill();
  }, [ready, still, stillKey, theme]);

  const pending = useRef(0);
  useFrame(
    (_now, dt) => {
      pending.current += dt;
      if (pending.current < 1000 / fps - 2 && pending.current > 0) return;
      const step = Math.min(0.1, pending.current / 1000);
      pending.current = 0;
      effectRef.current?.draw({ ...size.current, dt: step, still: false, theme: themeRef.current });
    },
    { visible, enabled: ready && !still },
  );

  const mode = !live ? (level === 'off' ? 'off' : 'fallback') : still ? 'still' : 'webgl';
  return (
    <div
      ref={rootRef}
      data-fx-stage={mode}
      className={cx('relative isolate overflow-hidden', className)}
    >
      {fallback && <div className="absolute inset-0">{fallback}</div>}
      {live && (
        <canvas
          ref={canvasRef}
          aria-hidden
          data-ready={ready || undefined}
          className="fx-canvas absolute inset-0 size-full"
        />
      )}
      {children}
    </div>
  );
}
