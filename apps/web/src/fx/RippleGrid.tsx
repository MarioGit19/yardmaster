/*
 * Adapted from RippleGrid by React Bits (https://reactbits.dev).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0: may be used as part
 * of Yardmaster, but the component must not be sold, sublicensed or redistributed on its own.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changes: lines only, in the Grid layout's neon (`--grid-neon`, DESIGN.md §10.4); ripples come
 * only from real events through `ripple()` (no auto or click ripples, no pointer glow); energy
 * lifts the line glow; no intro; Reduced draws the resting grid and ignores ripples.
 */
import { type Ref, useImperativeHandle, useRef } from 'react';
import { approach } from '../ambient/signal.js';
import { createQuadProgram, type Rgb, tokenColor } from './gl.js';
import { ShaderStage, type StageEffect } from './ShaderStage.js';

const MAX_RIPPLES = 12;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uView;
uniform float uRatio;
uniform float uCell;
uniform float uGlow;
uniform float uTilt;
uniform float uFocal;
uniform vec4 uRipples[${MAX_RIPPLES}];
uniform int uRippleCount;
uniform float uWaveLength;
uniform float uWaveSpeed;
uniform vec3 uColor;
uniform float uLight;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 css = gl_FragCoord.xy / uRatio;
  vec2 screen = vec2(css.x - uView.x * 0.5, uView.y * 0.5 - css.y);
  vec2 plane = screen;
  float horizon = 1.0;
  if (uTilt > 0.0001) {
    float depth = uFocal + screen.y * tan(uTilt);
    horizon = smoothstep(0.0, uFocal * 0.35, depth);
    float scale = uFocal / max(depth, 0.001);
    plane = vec2(screen.x * scale, screen.y * scale / cos(uTilt));
  }

  vec2 push = vec2(0.0);
  float lift = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    if (i >= uRippleCount) break;
    vec4 ripple = uRipples[i];
    vec2 delta = plane - ripple.xy;
    float dist = length(delta);
    float x = (dist - ripple.z * uWaveSpeed) / uWaveLength;
    float packet = exp(-x * x * 1.8);
    float spread = 1.0 / (1.0 + dist / (uWaveLength * 5.0));
    float calm = smoothstep(0.0, uWaveLength * 0.9, dist);
    float wave = sin(x * 6.28318) * packet * spread * calm * ripple.w;
    push += (dist > 0.001 ? delta / dist : vec2(0.0)) * wave;
    lift += wave;
  }

  vec2 grid = (plane + push * uCell * 0.22) / uCell;
  vec2 fw = max(fwidth(grid), vec2(0.00001));
  vec2 offset = abs(fract(grid - 0.5) - 0.5);
  vec2 dist = offset / fw;
  float width = max(uRatio, 1.0);
  float thin = min(uRatio, 1.0);
  vec2 cover = (1.0 - smoothstep(width * 0.5 - 0.5, width * 0.5 + 0.5, dist)) * thin;
  float shape = max(cover.x, cover.y);
  float halo = exp(-min(dist.x, dist.y) / (uRatio * 2.4)) * uGlow;
  float far = 1.0 - smoothstep(0.18, 0.5, max(fw.x, fw.y));
  float shine = max(1.0 + lift * 3.4, 0.25);

  vec2 uv = gl_FragCoord.xy / (uView * uRatio);
  vec2 fade = smoothstep(vec2(0.0), vec2(0.25), uv) * smoothstep(vec2(0.0), vec2(0.25), 1.0 - uv);
  float level = (shape * 0.26 + halo * 0.1) * shine * horizon * far * fade.x * fade.y;
  float dither = (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  float alpha = clamp(level * (uLight > 0.5 ? 1.2 : 1.0) + dither, 0.0, 1.0);
  vec3 color = uLight > 0.5 ? uColor : mix(uColor, vec3(1.0), clamp(level - 0.7, 0.0, 1.0));
  outColor = vec4(color * alpha, alpha);
}`;

interface Ripple {
  x: number;
  y: number;
  born: number;
  strength: number;
}

export interface RippleGridHandle {
  /** A ripple from (x, y), 0..1 across and down the grid, e.g. where a node just did something. */
  ripple(x: number, y: number, strength?: number): void;
}

interface Input {
  energy: number;
  cell: number;
  tilt: number;
}

interface Engine extends StageEffect {
  spawn(x: number, y: number, strength: number): void;
}

function rippleEffect(gl: WebGL2RenderingContext, input: { current: Input }): Engine | null {
  const program = createQuadProgram(gl, FRAGMENT);
  if (!program) return null;
  const { u } = program;
  const at = (name: string) => u[name] ?? null;
  const ripples: Ripple[] = [];
  const packed = new Float32Array(MAX_RIPPLES * 4);
  const view = { width: 1, height: 1 };
  let clock = 0;
  let still = false;
  let glow = input.current.energy;
  let color: { theme: string; rgb: Rgb } | null = null;
  let drawn = '';

  const focal = () => view.height * 1.15;
  const toPlane = (x: number, y: number): [number, number] | null => {
    const sx = x * view.width - view.width / 2;
    const sy = y * view.height - view.height / 2;
    const tilt = (input.current.tilt * Math.PI) / 180;
    if (tilt <= 0.0001) return [sx, sy];
    const depth = focal() + sy * Math.tan(tilt);
    if (depth <= focal() * 0.05) return null;
    const scale = focal() / depth;
    return [sx * scale, (sy * scale) / Math.cos(tilt)];
  };

  return {
    spawn(x, y, strength) {
      if (still) return;
      const point = toPlane(x, y);
      if (!point) return;
      ripples.push({ x: point[0], y: point[1], born: clock, strength });
      if (ripples.length > MAX_RIPPLES) ripples.shift();
    },
    draw(frame) {
      still = frame.still;
      const goal = input.current;
      if (color?.theme !== frame.theme)
        color = { theme: frame.theme, rgb: tokenColor('grid-neon') };
      view.width = frame.width / frame.ratio;
      view.height = frame.height / frame.ratio;
      clock += frame.dt;
      glow = still ? goal.energy : approach(glow, goal.energy, frame.dt * 1000, 1400);
      if (still) ripples.length = 0;
      while (ripples.length && clock - (ripples[0]?.born ?? 0) > 9) ripples.shift();
      let count = 0;
      for (let i = ripples.length - 1; i >= 0 && count < MAX_RIPPLES; i--) {
        const ripple = ripples[i];
        if (!ripple) continue;
        const age = clock - ripple.born;
        packed.set([ripple.x, ripple.y, age, ripple.strength * Math.exp(-age * 0.55)], count * 4);
        count++;
      }
      // A resting grid is drawn once; the canvas keeps it until a ripple or the glow moves.
      const state = `${frame.width}:${frame.height}:${frame.theme}:${goal.cell}:${goal.tilt}:${glow.toFixed(3)}`;
      if (count === 0 && state === drawn) return;
      drawn = count === 0 ? state : '';
      program.use(frame.width, frame.height);
      gl.uniform2f(at('uView'), view.width, view.height);
      gl.uniform1f(at('uRatio'), frame.ratio);
      gl.uniform1f(at('uCell'), goal.cell);
      gl.uniform1f(at('uGlow'), 0.4 + 0.6 * glow);
      gl.uniform1f(at('uTilt'), (goal.tilt * Math.PI) / 180);
      gl.uniform1f(at('uFocal'), focal());
      gl.uniform4fv(at('uRipples'), packed);
      gl.uniform1i(at('uRippleCount'), count);
      gl.uniform1f(at('uWaveLength'), goal.cell * 2.4);
      gl.uniform1f(at('uWaveSpeed'), 240);
      gl.uniform3fv(at('uColor'), color.rgb);
      gl.uniform1f(at('uLight'), frame.theme === 'light' ? 1 : 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      program.draw();
    },
    dispose: program.dispose,
  };
}

export interface RippleGridProps {
  /** 0..1, total activity: the lines glow brighter on a busy board. */
  energy: number;
  /** Grid cell size in CSS pixels. */
  cellSize?: number;
  /** Floor tilt in degrees (0 is flat, ~60 a perspective floor). */
  tilt?: number;
  className?: string;
  ref?: Ref<RippleGridHandle>;
}

/** The Grid layout's 2D map floor: a neon grid that ripples where work happens. */
export function RippleGrid({ energy, cellSize = 48, tilt = 0, className, ref }: RippleGridProps) {
  const input = useRef<Input>({ energy, cell: cellSize, tilt });
  input.current = { energy, cell: cellSize, tilt };
  const engine = useRef<Engine | null>(null);
  useImperativeHandle(
    ref,
    () => ({ ripple: (x, y, strength = 1) => engine.current?.spawn(x, y, strength) }),
    [],
  );
  return (
    <ShaderStage
      className={className}
      fps={60}
      stillKey={`${energy}:${cellSize}:${tilt}`}
      fallback={<div className="fx-grid-fallback size-full" />}
      create={(gl) => {
        engine.current = rippleEffect(gl, input);
        return engine.current;
      }}
    />
  );
}
