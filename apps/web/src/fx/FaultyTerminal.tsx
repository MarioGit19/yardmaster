/*
 * Adapted from FaultyTerminal by React Bits (https://reactbits.dev).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0: may be used as part
 * of Yardmaster, but the component must not be sold, sublicensed or redistributed on its own.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changes: one pass (the per-cell glyph state is computed in place, no persistence buffers or
 * 9-tap blur); only the 5×5 character glyphs; one phosphor tint from our Retro tokens, on our
 * background or, in Daylight, as ink on paper (DESIGN.md §10.6); the tearing, flicker and click
 * glitches are gone (nothing may flash more than 3 times a second), and energy speeds up the glyph
 * churn instead of the pointer.
 */
import { useRef } from 'react';
import { approach } from '../ambient/signal.js';
import { createQuadProgram, type Rgb, tokenColor } from './gl.js';
import { ShaderStage, type StageEffect } from './ShaderStage.js';

const FONT = [
  ['.###.', '#..##', '#.#.#', '##..#', '.###.'],
  ['..#..', '.##..', '..#..', '..#..', '.###.'],
  ['####.', '....#', '.###.', '#....', '#####'],
  ['####.', '....#', '.###.', '....#', '####.'],
  ['#..#.', '#..#.', '#####', '...#.', '...#.'],
  ['#####', '#....', '####.', '....#', '####.'],
  ['.###.', '#....', '####.', '#...#', '.###.'],
  ['#####', '....#', '...#.', '..#..', '..#..'],
  ['.###.', '#...#', '.###.', '#...#', '.###.'],
  ['.###.', '#...#', '.####', '....#', '.###.'],
  ['.###.', '#...#', '#####', '#...#', '#...#'],
  ['####.', '#...#', '####.', '#...#', '####.'],
  ['.####', '#....', '#....', '#....', '.####'],
  ['####.', '#...#', '#...#', '#...#', '####.'],
  ['#####', '#....', '####.', '#....', '#####'],
  ['#####', '#....', '####.', '#....', '#....'],
  ['.....', '..#..', '.###.', '..#..', '.....'],
  ['.....', '.....', '.###.', '.....', '.....'],
  ['.#...', '..#..', '...#.', '..#..', '.#...'],
  ['....#', '...#.', '..#..', '.#...', '#....'],
  ['.....', '#.#.#', '.###.', '#.#.#', '.....'],
  ['.....', '#####', '.....', '#####', '.....'],
  ['.....', '.....', '.....', '.....', '#####'],
];

const FONT_BITS = FONT.map((rows) =>
  rows.reduce((bits, row, r) => {
    let value = bits;
    for (let c = 0; c < 5; c++) if (row[c] === '#') value += 2 ** (r * 5 + c);
    return value;
  }, 0),
);

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform vec2 uCells;
uniform float uTime;
uniform float uEnergy;
uniform float uBrightness;
uniform vec3 uTint;
uniform vec3 uBase;
uniform float uLight;
out vec4 outColor;

const uint FONT[${FONT_BITS.length}] = uint[${FONT_BITS.length}](${FONT_BITS.map((bits) => `${bits}u`).join(', ')});

float time;

float noise(vec2 p) {
  return sin(p.x * 10.0) * sin(p.y * (3.0 + sin(time * 0.090909))) + 0.2;
}

mat2 rotate(float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c);
}

float fbm(vec2 p) {
  p *= 1.1;
  float f = 0.0;
  float amp = 0.5;
  mat2 modify = rotate(time * 0.02);
  f += amp * noise(p);
  p = modify * p * 2.0;
  amp *= 0.454545;
  f += amp * noise(p);
  p = modify * p * 2.0;
  amp *= 0.454545;
  f += amp * noise(p);
  return f;
}

float pattern(vec2 p) {
  mat2 rot01 = rotate(0.1 * time);
  mat2 rot1 = rotate(0.1);
  vec2 q = vec2(fbm(p + vec2(1.0)), fbm(rot01 * p + vec2(1.0)));
  vec2 r = vec2(fbm(rot1 * q), fbm(q));
  return fbm(p + r);
}

float hashCell(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec2 barrel(vec2 uv) {
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + 0.08 * dot(c, c);
  return c * 0.5 + 0.5;
}

void main() {
  time = uTime * 0.333333;
  vec2 uv = barrel(gl_FragCoord.xy / uRes);
  vec2 inside2 = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  float onScreen = inside2.x * inside2.y;

  vec2 grid = uv * uCells;
  vec2 cell = floor(grid);
  float intensity = pattern(cell / 15.0 * 0.1) * 1.3 - 0.03 + 0.12 * uEnergy;
  float on = step(0.1, intensity);
  float level = clamp((intensity - 0.1) / 0.6, 0.0, 1.0);

  // The glyph: a 5×5 character centred in the cell, swapped at a calm per-cell rate.
  vec2 p = fract(grid) * 1.5 - 0.25;
  float x = fract(p.x * 5.0);
  float y = fract((1.0 - p.y) * 5.0);
  int bit = int(floor((1.0 - p.y) * 5.0)) * 5 + int(floor(p.x * 5.0));
  float rate = 0.6 + 1.4 * uEnergy;
  float epoch = floor(uTime * rate + hashCell(cell * 1.37 + 4.1) * 7.0);
  float pick = hashCell(cell + vec2(epoch * 0.731, epoch * 1.913));
  uint glyph = FONT[int(min(pick * float(FONT.length()), float(FONT.length()) - 1.0))];
  float lit = float((glyph >> uint(clamp(bit, 0, 24))) & 1u);
  float inCell = step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0);
  float core = inCell * lit * on * (0.35 + 0.65 * level) * (0.2 + y * 0.8) * (0.75 + x * 0.25);
  float halo = on * level * 0.22;

  // Fine static scanlines and a soft edge vignette (CSS-only curvature lives on the frame).
  float scan = 0.82 + 0.18 * sin(gl_FragCoord.y * 3.14159 * 0.5);
  vec2 edge = smoothstep(vec2(0.0), vec2(0.12), uv) * smoothstep(vec2(0.0), vec2(0.12), 1.0 - uv);
  float vignette = edge.x * edge.y;
  float glow = (core + halo) * scan * vignette * onScreen * uBrightness * (0.75 + 0.25 * uEnergy);

  vec3 color = uLight > 0.5
    ? mix(uBase, uTint, clamp(glow * 1.3, 0.0, 0.85))
    : uBase + uTint * glow;
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

/** Character cell size in CSS pixels. */
const CELL_PX = 14;

export type Phosphor = 'green' | 'amber';

interface Input {
  energy: number;
  brightness: number;
  phosphor: Phosphor;
}

function terminalEffect(gl: WebGL2RenderingContext, input: { current: Input }): StageEffect | null {
  const program = createQuadProgram(gl, FRAGMENT);
  if (!program) return null;
  const { u } = program;
  const at = (name: string) => u[name] ?? null;
  let time = 40;
  let energy = input.current.energy;
  let colors: { key: string; tint: Rgb; base: Rgb } | null = null;
  return {
    draw(frame) {
      const goal = input.current;
      const key = `${frame.theme}:${goal.phosphor}`;
      // Tokens are read on a theme or phosphor change, never per frame.
      if (colors?.key !== key) {
        colors = {
          key,
          tint: tokenColor(goal.phosphor === 'amber' ? 'retro-amber' : 'retro-fg'),
          base: tokenColor('retro-bg'),
        };
      }
      energy = frame.still ? goal.energy : approach(energy, goal.energy, frame.dt * 1000, 1400);
      time += frame.dt * (0.3 + 0.5 * energy);
      const cell = CELL_PX * frame.ratio;
      program.use(frame.width, frame.height);
      gl.uniform2f(at('uRes'), frame.width, frame.height);
      gl.uniform2f(at('uCells'), frame.width / cell, frame.height / cell);
      gl.uniform1f(at('uTime'), time);
      gl.uniform1f(at('uEnergy'), energy);
      gl.uniform1f(at('uBrightness'), goal.brightness);
      gl.uniform3fv(at('uTint'), colors.tint);
      gl.uniform3fv(at('uBase'), colors.base);
      gl.uniform1f(at('uLight'), frame.theme === 'light' ? 1 : 0);
      program.draw();
    },
    dispose: program.dispose,
  };
}

export interface FaultyTerminalProps {
  /** 0..1: busier boards churn glyphs faster and glow a little brighter. */
  energy: number;
  /** Phosphor color (DESIGN.md §10.6), green by default. */
  phosphor?: Phosphor;
  /** Overall glyph brightness, kept low so console text above stays readable. */
  brightness?: number;
  className?: string;
}

/** The Retro layout's backdrop: a field of churning phosphor glyphs behind the console. */
export function FaultyTerminal({
  energy,
  phosphor = 'green',
  brightness = 0.45,
  className,
}: FaultyTerminalProps) {
  const input = useRef<Input>({ energy, brightness, phosphor });
  input.current = { energy, brightness, phosphor };
  return (
    <ShaderStage
      className={className}
      fps={24}
      stillKey={`${energy}:${phosphor}:${brightness}`}
      fallback={<div className="fx-terminal-fallback size-full" data-phosphor={phosphor} />}
      create={(gl) => terminalEffect(gl, input)}
    />
  );
}
