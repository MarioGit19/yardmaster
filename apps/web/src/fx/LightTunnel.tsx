/*
 * Adapted from LightTunnel by React Bits (https://reactbits.dev).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0: may be used as part
 * of Yardmaster, but the component must not be sold, sublicensed or redistributed on its own.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changes: driven by props instead of the pointer: `speed` is the travel (the Grid dive, DESIGN.md
 * §10.4, ramps it up and back down), `energy` sets how many cables carry pulses, and each new
 * `surge` sends one bright ring down the tunnel; cables and pulses take `--grid-neon`; no grain,
 * click surge or intro; WebGL2 via `fx/gl.ts`.
 */
import { useRef } from 'react';
import { approach } from '../ambient/signal.js';
import { createQuadProgram, type Rgb, tokenColor } from './gl.js';
import { ShaderStage, type StageEffect } from './ShaderStage.js';

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform vec2 uCenter;
uniform float uScale;
uniform float uRatio;
uniform float uTime;
uniform float uDrift;
uniform vec2 uSteer;
uniform float uBend;
uniform float uCount;
uniform float uSwing;
uniform float uWave;
uniform float uWidth;
uniform float uPulseWidth;
uniform float uHead;
uniform float uTail;
uniform float uChance;
uniform float uSpacing;
uniform float uPulseSpeed;
uniform float uFlow;
uniform float uHalo;
uniform float uGlow;
uniform float uBrightness;
uniform float uVariance;
uniform float uBody;
uniform float uFadeNear;
uniform float uFadeFar;
uniform vec3 uCable;
uniform vec3 uPulse;
uniform vec3 uTunnel;
uniform vec3 uSurge;
uniform float uReveal;
uniform float uGrain;
uniform float uSeed;
uniform float uLight;
uniform float uOpacity;
out vec4 outColor;

const float TAU = 6.2831853;

vec3 inkOf(vec3 color, float depthOfInk) {
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float peak = max(color.r, max(color.g, color.b));
  float chroma = (peak - min(color.r, min(color.g, color.b))) / max(peak, 0.001);
  return color * min(1.0, mix(depthOfInk, depthOfInk * 1.7, chroma) / max(luma, 0.001));
}

float hash(float n) {
  return fract(sin(n * 127.1 + uSeed * 311.7) * 43758.5453);
}

vec2 bendAt(float depth) {
  float reach = 1.0 - exp(-max(depth, 0.0) * 0.55);
  vec2 wobble = vec2(sin(uDrift * 0.37 + depth * 0.31), cos(uDrift * 0.29 + depth * 0.23)) * uBend;
  return (wobble + uSteer) * reach;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution - uCenter) / uScale;
  float depth = -log(max(length(p), 1e-5));
  vec2 q = p;
  for (int i = 0; i < 4; i++) {
    q = p - bendAt(depth);
    depth = -log(max(length(q), 1e-5));
  }
  float r = length(q);
  float px = r * uScale;
  float turn = atan(q.y, q.x) / TAU;
  float s = turn - uSwing - uWave * sin(depth * 1.2 + uDrift * 0.5);
  float cell = floor(s * uCount);
  float spacing = TAU * px / uCount;
  float near = smoothstep(0.55, 1.25, r);
  float width = uWidth * (1.0 + near * 1.2);
  float soft = uRatio * (0.55 + near * 0.9);
  float tight = uRatio * uHalo * (1.0 + near);
  float wide = tight * 4.5;

  float lines = 0.0;
  float body = 0.0;
  vec3 glow = vec3(0.0);
  float strokes = 0.0;
  for (int k = -3; k <= 3; k++) {
    float i = cell + float(k);
    float id = mod(i, uCount);
    float h1 = hash(id);
    float h2 = hash(id + 17.0);
    float h3 = hash(id + 41.0);
    float h4 = hash(id + 73.0);
    float center = (i + 0.5 + (h1 - 0.5) * 0.55) / uCount;
    center += 0.12 * sin(depth * (0.8 + h2 * 0.9) + uDrift * (0.4 + h3 * 0.5) + h4 * TAU) / uCount;
    float d = abs(s - center) * TAU * px;
    float shade = 1.0 + uVariance * (h3 - 0.5) * 0.9;
    float reach = smoothstep(spacing * 2.4, spacing * 1.4, d);

    lines += smoothstep(width + soft, width - soft, d) * shade;
    body += exp(-d / max(spacing * 0.22, 0.001)) * shade * reach;

    float x = depth * uSpacing + uTime * uPulseSpeed * (0.55 + h2 * 0.6) * uFlow + h4 * 7.0;
    float lead = (fract(x) - 0.5) / uSpacing * uFlow;
    float lit = step(hash(id * 3.7 + floor(x) * 13.1), uChance);
    float limit = 0.5 / uSpacing;
    float head = exp(-pow(max(-lead, 0.0) / uHead, 2.0)) * smoothstep(-limit, -limit * 0.8, lead);
    float tail = exp(-max(lead, 0.0) / uTail) * smoothstep(limit, limit * 0.55, lead);
    float pulse = (lead < 0.0 ? head : tail) * lit;
    float ring = uSurge.y * exp(-pow((depth - uSurge.x) / uSurge.z, 2.0));
    pulse = max(pulse, ring);
    float hot = pulse * (lead < 0.0 ? 1.0 : exp(-max(lead, 0.0) / (uTail * 0.35)));

    float core = uPulseWidth * width + 0.35 * uRatio;
    float stroke = smoothstep(core + soft, core - soft, d);
    float bloom = (exp(-d / tight) * 0.7 + exp(-d / wide) * 0.18) * uGlow * reach;
    vec3 tint = mix(uPulse, vec3(1.0), hot * 0.55 * (1.0 - uLight));
    glow += tint * pulse * (stroke * 1.5 + bloom) * shade;
    strokes += pulse * stroke * shade;
  }

  float lod = smoothstep(4.0, 1.2, spacing);
  float average = min(2.0 * uWidth / max(spacing, 0.001), 1.0);
  lines = mix(lines, average, lod);
  glow = mix(glow, uPulse * average * 0.6 * uChance, lod);
  strokes = mix(strokes, average * 0.6 * uChance, lod);
  body = mix(body, 1.0, lod) * uBody;

  float rr = r * 0.25;
  float fade = smoothstep(0.0, uFadeNear, rr) * smoothstep(uFadeFar, uFadeFar * 0.55, rr);
  fade *= smoothstep(uReveal - 0.6, uReveal, depth);

  float grain = 1.0;
  if (uGrain > 0.0) {
    grain += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uTime * 7.0) * 43758.5453) - 0.5) * uGrain * 4.0;
  }

  if (uLight > 0.5) {
    float hairline = clamp(lines * 0.26 + body * 0.2, 0.0, 1.0);
    float stroke = clamp(strokes * 1.6, 0.0, 1.0);
    float haze = clamp(length(glow) * 0.12, 0.0, 0.25);
    float ink = clamp(hairline + stroke + haze, 0.0, 1.0) * fade * uOpacity * grain;
    vec3 tone = mix(inkOf(uCable, 0.3), inkOf(uPulse, 0.16), clamp(stroke + haze * 2.0, 0.0, 1.0));
    tone = mix(tone, inkOf(uTunnel, 0.3), clamp(body * uBody, 0.0, 1.0) * 0.5);
    outColor = vec4(tone * ink, ink);
    return;
  }

  vec3 light = (uCable * lines * 0.12 + uTunnel * body * 0.35 + glow) * uBrightness * fade * grain;
  vec3 mapped = (1.0 - exp(-light * 1.4)) * uOpacity;
  outColor = vec4(mapped, max(mapped.r, max(mapped.g, mapped.b)));
}`;

interface Input {
  speed: number;
  energy: number;
  surge: number;
}

function tunnelEffect(gl: WebGL2RenderingContext, input: { current: Input }): StageEffect | null {
  const program = createQuadProgram(gl, FRAGMENT);
  if (!program) return null;
  const { u } = program;
  const at = (name: string) => u[name] ?? null;
  let time = 0;
  let drift = 0;
  let speed = input.current.speed;
  let energy = input.current.energy;
  let surgeKey = input.current.surge;
  let surgeAge = 10;
  let colors: { theme: string; neon: Rgb; tunnel: Rgb } | null = null;

  return {
    draw(frame) {
      const goal = input.current;
      if (colors?.theme !== frame.theme) {
        colors = {
          theme: frame.theme,
          neon: tokenColor('grid-neon'),
          tunnel: tokenColor('st-work'),
        };
      }
      const ms = frame.dt * 1000;
      speed = frame.still ? 0 : approach(speed, goal.speed, ms, 180);
      energy = frame.still ? goal.energy : approach(energy, goal.energy, ms, 900);
      if (goal.surge !== surgeKey) {
        surgeKey = goal.surge;
        surgeAge = frame.still ? 10 : 0;
      }
      // A slow idle drift keeps the tunnel alive at rest; travel adds on top.
      time += frame.dt * (0.1 + 2.4 * speed);
      drift += frame.dt * (0.3 + 0.8 * speed);
      surgeAge += frame.dt;

      const { width, height, ratio } = frame;
      const minSide = Math.min(width, height);
      const travel = surgeAge * 2.6;
      const surgeLevel =
        surgeAge < 2.4 ? Math.min(1, surgeAge / 0.12) * Math.exp(-surgeAge * 1.1) : 0;
      const pulseLength = 0.28 * 1.2 * (1 + speed * 1.5);

      program.use(width, height);
      gl.uniform2f(at('uResolution'), width, height);
      gl.uniform2f(at('uCenter'), 0, 0);
      gl.uniform1f(at('uScale'), minSide * 0.5);
      gl.uniform1f(at('uRatio'), ratio);
      gl.uniform1f(at('uTime'), time);
      gl.uniform1f(at('uDrift'), drift);
      gl.uniform2f(at('uSteer'), 0, 0);
      gl.uniform1f(at('uBend'), 0.4 * 0.45);
      gl.uniform1f(at('uCount'), 56);
      gl.uniform1f(at('uSwing'), (Math.sin(drift * 0.9) * 0.25) / (Math.PI * 2));
      gl.uniform1f(at('uWave'), 0.3 * 0.15);
      gl.uniform1f(at('uWidth'), (0.25 + 0.35 * 1.5) * ratio);
      gl.uniform1f(at('uPulseWidth'), 1.5);
      gl.uniform1f(at('uHead'), pulseLength * 0.212);
      gl.uniform1f(at('uTail'), pulseLength * 0.92);
      gl.uniform1f(at('uChance'), 0.2 + 0.6 * energy);
      gl.uniform1f(at('uSpacing'), 0.4);
      gl.uniform1f(at('uPulseSpeed'), 8 * (0.4 + speed));
      gl.uniform1f(at('uFlow'), -1);
      gl.uniform1f(at('uHalo'), 2.4);
      gl.uniform1f(at('uGlow'), 0.8 + 0.6 * speed);
      gl.uniform1f(at('uBrightness'), 0.8 + 0.5 * speed);
      gl.uniform1f(at('uVariance'), 1);
      gl.uniform1f(at('uBody'), 0.15 * speed);
      gl.uniform1f(at('uFadeNear'), 0.5);
      gl.uniform1f(at('uFadeFar'), 2);
      gl.uniform3fv(at('uCable'), colors.neon);
      gl.uniform3fv(at('uPulse'), colors.neon);
      gl.uniform3fv(at('uTunnel'), colors.tunnel);
      gl.uniform3f(at('uSurge'), -0.6 + travel, surgeLevel, 0.22);
      gl.uniform1f(at('uReveal'), -1.9);
      gl.uniform1f(at('uGrain'), 0);
      gl.uniform1f(at('uSeed'), 0);
      gl.uniform1f(at('uLight'), frame.theme === 'light' ? 1 : 0);
      gl.uniform1f(at('uOpacity'), 1);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      program.draw();
    },
    dispose: program.dispose,
  };
}

export interface LightTunnelProps {
  /** 0..1 travel speed: 0 drifts at rest, 1 is the dive at full pace. */
  speed?: number;
  /** 0..1, the project's activity: more cables carry light pulses. */
  energy?: number;
  /** Change it to send one bright ring down the tunnel (arriving, a finished turn). */
  surge?: number;
  className?: string;
}

/** The Grid dive's travel effect: a tunnel of neon cables rushing toward the viewer. */
export function LightTunnel({ speed = 0, energy = 0.5, surge = 0, className }: LightTunnelProps) {
  const input = useRef<Input>({ speed, energy, surge });
  input.current = { speed, energy, surge };
  return (
    <ShaderStage
      className={className}
      resolution={0.75}
      stillKey={`${energy}:${surge}`}
      fallback={<div className="fx-tunnel-fallback size-full" />}
      create={(gl) => tunnelEffect(gl, input)}
    />
  );
}
