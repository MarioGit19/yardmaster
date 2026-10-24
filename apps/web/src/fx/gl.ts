// Shared WebGL2 plumbing for the fx backgrounds: one full-screen triangle from `gl_VertexID` (no
// buffers), a program with its uniform locations, and CSS colors resolved to linear-ish RGB.

export type Rgb = readonly [number, number, number];

/** The vertex shader every fx background shares: a triangle that covers the viewport. */
export const FULLSCREEN_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export interface QuadProgram {
  readonly gl: WebGL2RenderingContext;
  /** Uniform locations by name (array uniforms without their `[0]`). */
  readonly u: Record<string, WebGLUniformLocation | null>;
  /** Binds the program; set uniforms after this, then `draw()`. */
  use(width: number, height: number): void;
  draw(): void;
  dispose(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.warn('[yardmaster] fx shader failed to compile', gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
  return null;
}

/** A program drawing `fragment` over the whole canvas, or null if it doesn't compile. */
export function createQuadProgram(
  gl: WebGL2RenderingContext,
  fragment: string,
): QuadProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  const program = vs && fs ? gl.createProgram() : null;
  if (!vs || !fs || !program) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[yardmaster] fx shader failed to link', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  const u: Record<string, WebGLUniformLocation | null> = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info) u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
  }
  const vao = gl.createVertexArray();

  return {
    gl,
    u,
    use(width, height) {
      gl.viewport(0, 0, width, height);
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL, not a React hook.
      gl.useProgram(program);
      gl.bindVertexArray(vao);
    },
    draw() {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      if (gl.isContextLost()) return;
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}

/** Frees the context now instead of at garbage collection (one context at a time, §7). */
export function releaseContext(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  gl.getExtension('WEBGL_lose_context')?.loseContext();
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#rgb`/`#rrggbb` to 0..1 channels; null for anything else. */
export function parseHex(value: string): Rgb | null {
  const match = HEX.exec(value.trim());
  if (!match?.[1]) return null;
  const hex =
    match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1];
  const n = Number.parseInt(hex, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

let probe: CanvasRenderingContext2D | null | undefined;
const resolved = new Map<string, Rgb>();

/**
 * Any CSS color (hex, rgb(), oklch(), color-mix()) as 0..1 sRGB channels, via a 1×1 canvas.
 * Falls back to `fallback` where no canvas exists (tests).
 */
export function cssColor(value: string, fallback: Rgb = [1, 1, 1]): Rgb {
  const hex = parseHex(value);
  if (hex) return hex;
  const cached = resolved.get(value);
  if (cached) return cached;
  if (probe === undefined) {
    try {
      probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    } catch {
      probe = null;
    }
  }
  if (!probe) return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
  const rgb: Rgb = [r / 255, g / 255, b / 255];
  resolved.set(value, rgb);
  return rgb;
}

/** A design token's current value (`--st-tool`) as RGB. Call on theme change, not per frame. */
export function tokenColor(name: string, fallback?: Rgb): Rgb {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return value ? cssColor(value, fallback) : (fallback ?? [1, 1, 1]);
}
