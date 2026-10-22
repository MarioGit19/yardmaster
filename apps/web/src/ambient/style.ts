import { createVeil } from '../fx/DarkVeil.js';
import { releaseContext } from '../fx/gl.js';
import { createAurora } from '../fx/SoftAurora.js';
import { createPreference } from '../prefs.js';
import { createFieldRenderer, type FieldRenderer } from './renderer.js';

/** Settings → Appearance → Ambient: the nebula (§4.1), two alternatives adapted from React Bits, or none. */
export const AMBIENT_STYLES = ['nebula', 'veil', 'aurora', 'none'] as const;
export type AmbientStyle = (typeof AMBIENT_STYLES)[number];

export const AMBIENT_STYLE_LABEL: Record<AmbientStyle, string> = {
  nebula: 'Nebula',
  veil: 'Veil',
  aurora: 'Aurora',
  none: 'None',
};

/**
 * Fraction of the device pixel ratio each style renders at (DESIGN.md §4.1 asks 0.5×). The aurora
 * is smooth enough to render lower, which keeps it cheap on weak and software GPUs.
 */
export const AMBIENT_RESOLUTION: Record<Exclude<AmbientStyle, 'none'>, number> = {
  nebula: 0.5,
  veil: 0.5,
  aurora: 0.35,
};

export const ambientStylePreference = createPreference<AmbientStyle>(
  'cboard.ambient',
  AMBIENT_STYLES,
  'nebula',
);

/**
 * The shader renderer for a style on `canvas`, or null where WebGL (WebGL2 for Veil and Aurora)
 * is missing; the caller then shows the CSS field. Disposing frees the context right away.
 */
export function createAmbientRenderer(
  style: Exclude<AmbientStyle, 'none'>,
  canvas: HTMLCanvasElement,
): FieldRenderer | null {
  if (style === 'nebula') return createFieldRenderer(canvas);
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const context = gl;
  const renderer = style === 'veil' ? createVeil(context) : createAurora(context);
  if (!renderer) return null;
  return {
    draw: renderer.draw,
    dispose() {
      renderer.dispose();
      releaseContext(context);
    },
  };
}
