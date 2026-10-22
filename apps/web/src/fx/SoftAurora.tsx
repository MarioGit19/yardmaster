/*
 * Adapted from SoftAurora by React Bits (https://reactbits.dev).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0: may be used as part
 * of c-board, but the component must not be sold, sublicensed or redistributed on its own.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changes: the two Perlin aurora bands are mapped onto the ambient field palette (DESIGN.md §4.1,
 * max L ≈ 12%) instead of a rainbow gradient, hang near the top of the room, and brighten, widen
 * and flow faster with energy; adds the amber attention bloom; no pointer, click pulses or intro.
 */
import type { FieldRenderer } from '../ambient/renderer.js';
import { type FieldEffectProps, FieldStage, fieldRenderer } from './FieldStage.js';

const FRAGMENT = `#version 300 es
precision highp float;
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
out vec4 outColor;

// A random gradient per lattice point; cheaper than the upstream spherical one (no acos/sin/cos),
// which matters on software WebGL.
vec3 gradientHash(vec3 p) {
  p = vec3(
    dot(p, vec3(127.1, 311.7, 234.6)),
    dot(p, vec3(269.5, 183.3, 198.3)),
    dot(p, vec3(169.5, 283.3, 156.9))
  );
  return normalize(fract(sin(p) * 43758.5453123) * 2.0 - 1.0 + 1e-4);
}

float quinticSmooth(float t) {
  float t2 = t * t;
  float t3 = t * t2;
  return 6.0 * t3 * t2 - 15.0 * t2 * t2 + 10.0 * t3;
}

float perlin3D(float amplitude, float frequency, float px, float py, float pz) {
  float x = px * frequency;
  float y = py * frequency;
  float fx = floor(x);
  float fy = floor(y);
  float fz = floor(pz);
  float cx = ceil(x);
  float cy = ceil(y);
  float cz = ceil(pz);

  float d000 = dot(gradientHash(vec3(fx, fy, fz)), vec3(x - fx, y - fy, pz - fz));
  float d100 = dot(gradientHash(vec3(cx, fy, fz)), vec3(x - cx, y - fy, pz - fz));
  float d010 = dot(gradientHash(vec3(fx, cy, fz)), vec3(x - fx, y - cy, pz - fz));
  float d110 = dot(gradientHash(vec3(cx, cy, fz)), vec3(x - cx, y - cy, pz - fz));
  float d001 = dot(gradientHash(vec3(fx, fy, cz)), vec3(x - fx, y - fy, pz - cz));
  float d101 = dot(gradientHash(vec3(cx, fy, cz)), vec3(x - cx, y - fy, pz - cz));
  float d011 = dot(gradientHash(vec3(fx, cy, cz)), vec3(x - fx, y - cy, pz - cz));
  float d111 = dot(gradientHash(vec3(cx, cy, cz)), vec3(x - cx, y - cy, pz - cz));

  float sx = quinticSmooth(x - fx);
  float sy = quinticSmooth(y - fy);
  float sz = quinticSmooth(pz - fz);
  float ly0 = mix(mix(d000, d100, sx), mix(d010, d110, sx), sy);
  float ly1 = mix(mix(d001, d101, sx), mix(d011, d111, sx), sy);
  return amplitude * mix(ly0, ly1, sz);
}

// One aurora curtain: Perlin noise bends a horizontal band. Two octaves (the upstream third
// added about 1%).
float auroraGlow(float t, vec2 uv, float height, float spread) {
  vec2 samplePos = uv * 1.5;
  float noiseVal = perlin3D(1.0, 2.5, samplePos.x, samplePos.y, t)
    + perlin3D(0.1, 5.0, samplePos.x, samplePos.y, t);
  float yBand = uv.y * 10.0 - height * 10.0;
  return 0.3 * max(exp(spread * (1.0 - 1.1 * abs(noiseVal + yBand))), 0.0);
}

void main() {
  vec2 screen = gl_FragCoord.xy / uRes;
  vec2 field = gl_FragCoord.xy / uRes.y;
  float t = uTime * 2.5;
  // A busy board widens the curtains and lifts them a little.
  float spread = 0.8 + 0.5 * uEnergy;
  // The curtains hang high in the room, above the pods' first row.
  float height = 0.84 + 0.03 * uEnergy;
  vec3 color = uBase;
  // Far below the curtains there is nothing to light: skip the noise.
  if (field.y > height - 0.75) {
    float glow1 = auroraGlow(t, field, height, spread);
    float glow2 = auroraGlow(t + 0.6, field, height - 0.1, spread);

    float level = (glow1 + glow2) * (0.55 + 0.75 * uEnergy);
    float lit = 1.0 - exp(-level * 1.6);
    vec3 tint = mix(uDeep, uViolet, glow2 / max(glow1 + glow2, 1e-4));
    color = mix(uBase, tint, clamp(lit * uGain * 1.4, 0.0, 1.0));
  }

  vec2 d = screen - vec2(uAttnPos.x, 1.0 - uAttnPos.y);
  d.x *= uRes.x / max(uRes.y, 1.0);
  float bloom = exp(-dot(d, d) * 5.0) * uAttention;
  color = mix(color, uAmber, clamp(bloom * uGain, 0.0, 1.0));
  outColor = vec4(color, 1.0);
}`;

/** The Aurora ambient style: same inputs and palette as the nebula field. */
export const createAurora = (gl: WebGL2RenderingContext): FieldRenderer | null =>
  fieldRenderer(gl, FRAGMENT);

/** The Aurora field in a box (showcase); the ambient field uses `createAurora` directly. */
export function SoftAurora(props: FieldEffectProps) {
  return <FieldStage {...props} create={createAurora} />;
}
