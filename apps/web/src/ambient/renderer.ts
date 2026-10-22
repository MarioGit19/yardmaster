// The ambient field shader, DESIGN.md §4.1: a slow, domain-warped fbm nebula (3 octaves) at
// very low luminance, brighter and faster with `uEnergy`, with an amber bloom at `uAttnPos`.

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAGMENT = `
precision mediump float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uTime;
uniform float uEnergy;
uniform float uAttention;
uniform vec2 uAttnPos;
uniform vec3 uBase;
uniform vec3 uDeep;
uniform vec3 uViolet;
uniform vec3 uAmber;
uniform float uGain;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = r * p * 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2(vUv.x * aspect, vUv.y) * 1.7;
  float t = uTime;
  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.6)), fbm(p + vec2(5.2, 1.3) - t * 0.4));
  float f = fbm(p + 1.9 * q + vec2(t * 0.3, -t * 0.2));

  // Energy widens the lit bands and lifts them: a calm room is mostly floor, a busy one glows.
  float band = smoothstep(0.3 - 0.1 * uEnergy, 0.92 - 0.2 * uEnergy, f);
  // Light pools toward the top of the room, so content below stays on a calm, dark floor.
  float sky = mix(0.45, 1.0, smoothstep(0.0, 1.0, vUv.y));
  float lift = (0.3 + 0.7 * uEnergy) * sky;
  vec3 tint = mix(uDeep, uViolet, smoothstep(0.35, 0.85, q.x));
  vec3 color = mix(uBase, tint, clamp(band * lift * uGain, 0.0, 1.0));

  vec2 d = vUv - vec2(uAttnPos.x, 1.0 - uAttnPos.y);
  d.x *= aspect;
  float bloom = exp(-dot(d, d) * 5.0) * uAttention * (0.75 + 0.25 * f);
  color = mix(color, uAmber, clamp(bloom * uGain, 0.0, 1.0));

  gl_FragColor = vec4(color, 1.0);
}
`;

export type Rgb = readonly [number, number, number];

export interface FieldPalette {
  base: Rgb;
  deep: Rgb;
  violet: Rgb;
  amber: Rgb;
  gain: number;
}

const rgb = (hex: string): Rgb => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** Night stays under ~12% lightness; Daylight is a faint cool wash over the paper base. */
export const FIELD_PALETTES = {
  dark: {
    base: rgb('#05060a'),
    deep: rgb('#121c48'),
    violet: rgb('#22134a'),
    amber: rgb('#3a2508'),
    gain: 0.9,
  },
  light: {
    base: rgb('#f7f7f4'),
    deep: rgb('#dde3f6'),
    violet: rgb('#e9e0f4'),
    amber: rgb('#f8e2bd'),
    gain: 0.8,
  },
} as const satisfies Record<'dark' | 'light', FieldPalette>;

export interface FieldFrame {
  width: number;
  height: number;
  time: number;
  energy: number;
  attention: number;
  attentionX: number;
  attentionY: number;
  palette: FieldPalette;
}

export interface FieldRenderer {
  draw(frame: FieldFrame): void;
  dispose(): void;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[c-board] ambient shader failed to compile', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** A renderer on `canvas`, or null when WebGL is unavailable (the caller shows the CSS field). */
export function createFieldRenderer(canvas: HTMLCanvasElement): FieldRenderer | null {
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl', {
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

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[c-board] ambient shader failed to link', gl.getProgramInfoLog(program));
    return null;
  }
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL, not a React hook.
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = (name: string) => gl.getUniformLocation(program, name);
  const loc = {
    res: u('uRes'),
    time: u('uTime'),
    energy: u('uEnergy'),
    attention: u('uAttention'),
    attnPos: u('uAttnPos'),
    base: u('uBase'),
    deep: u('uDeep'),
    violet: u('uViolet'),
    amber: u('uAmber'),
    gain: u('uGain'),
  };

  return {
    draw(frame) {
      if (gl.isContextLost()) return;
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      gl.viewport(0, 0, frame.width, frame.height);
      gl.uniform2f(loc.res, frame.width, frame.height);
      gl.uniform1f(loc.time, frame.time);
      gl.uniform1f(loc.energy, frame.energy);
      gl.uniform1f(loc.attention, frame.attention);
      gl.uniform2f(loc.attnPos, frame.attentionX, frame.attentionY);
      gl.uniform3fv(loc.base, frame.palette.base);
      gl.uniform3fv(loc.deep, frame.palette.deep);
      gl.uniform3fv(loc.violet, frame.palette.violet);
      gl.uniform3fv(loc.amber, frame.palette.amber);
      gl.uniform1f(loc.gain, frame.palette.gain);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    },
  };
}
