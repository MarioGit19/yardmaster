import { EFFECT_DURATION, type OrbEffect, type OrbState } from './model.js';

export type Rgb = readonly [number, number, number];

export interface OrbPalette {
  /** The state's status color (`--st-*`). */
  status: Rgb;
  /** The session's identity color: the faint rim. */
  accent: Rgb;
  /** Tool-family color for orbiting particles. */
  family: Rgb;
  satellite: Rgb;
  ok: Rgb;
  /** Page base, for glyphs cut into the core. */
  base: Rgb;
  light: boolean;
}

export interface OrbFrame {
  state: OrbState;
  /** CSS px of the orb's box; the canvas spans twice this so halos and orbits fit. */
  size: number;
  /** Seconds since mount, offset per instance so orbs never move in sync. */
  time: number;
  /** Seconds since the orb entered `state`. */
  stateTime: number;
  effect: { kind: OrbEffect; time: number } | null;
  particles: number;
  satellites: number;
  /** 0..1 of the countdown elapsed, or null without one. */
  countdown: number | null;
  /** False at the Reduced and Off levels: color and static rings only. */
  moving: boolean;
}

/** The canvas extends half the orb size past each edge. */
export const CANVAS_SCALE = 2;
/** Sphere radius as a fraction of the orb box. */
const RADIUS = 0.36;
const TAU = Math.PI * 2;

const rgba = ([r, g, b]: Rgb, a: number) =>
  `rgb(${r | 0} ${g | 0} ${b | 0} / ${Math.max(0, Math.min(1, a)).toFixed(3)})`;

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function grey([r, g, b]: Rgb): Rgb {
  const l = 0.3 * r + 0.59 * g + 0.11 * b;
  return [l, l, l];
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

interface Look {
  core: Rgb;
  /** Halo strength 0..1. */
  halo: number;
  /** Highlight strength on the sphere. */
  light: number;
  rim: number;
  alpha: number;
}

function lookFor(frame: OrbFrame, palette: OrbPalette): Look {
  const { status, accent } = palette;
  const t = frame.time;
  switch (frame.state) {
    case 'idle':
      return { core: mix(status, accent, 0.25), halo: 0.06, light: 0.18, rim: 0.55, alpha: 0.72 };
    case 'working':
      return { core: status, halo: 0.42, light: 0.42, rim: 0.3, alpha: 1 };
    case 'tool':
      // Tinted toward the tool family, so Bash and Edit differ beyond their particles.
      return {
        core: mix(status, palette.family, 0.3),
        halo: 0.36,
        light: 0.38,
        rim: 0.3,
        alpha: 1,
      };
    case 'waiting': {
      // The slow amber breathing glow, 2.4 s.
      const breath = frame.moving ? 0.5 - 0.5 * Math.cos((TAU * t) / 2.4) : 0.5;
      return { core: status, halo: 0.26 + 0.3 * breath, light: 0.36, rim: 0.25, alpha: 1 };
    }
    case 'error':
      return { core: status, halo: 0.42, light: 0.3, rim: 0.2, alpha: 1 };
    case 'compacting':
      return { core: status, halo: 0.28, light: 0.3, rim: 0.3, alpha: 0.92 };
    case 'ended':
      return { core: grey(status), halo: 0, light: 0.08, rim: 0.16, alpha: 0.5 };
  }
}

/** Orbit position on a tilted ellipse; `depth` > 0 is in front of the sphere. */
function orbit(angle: number, radius: number, tilt: number) {
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius * tilt,
    depth: Math.sin(angle),
  };
}

/** Draws one frame into a context already scaled to CSS px. */
export function drawOrb(ctx: CanvasRenderingContext2D, frame: OrbFrame, palette: OrbPalette) {
  const extent = frame.size * CANVAS_SCALE;
  ctx.clearRect(0, 0, extent, extent);
  const c = extent / 2;
  const look = lookFor(frame, palette);
  const unit = frame.size / 40;

  let scale = 1;
  if (frame.state === 'compacting') {
    scale = 1 - 0.15 * (frame.moving ? easeOut(clamp01(frame.stateTime / 0.4)) : 1);
  }
  if (frame.effect?.kind === 'expand') {
    scale = 0.85 + 0.15 * easeOut(clamp01(frame.effect.time / EFFECT_DURATION.expand));
  }
  const R = frame.size * RADIUS * scale;

  let dx = 0;
  const { effect } = frame;
  if (effect?.kind === 'glitch') dx = effect.time < EFFECT_DURATION.glitch / 2 ? 2 : -2;

  ctx.save();
  ctx.translate(c + dx, c);

  // Halo.
  if (look.halo > 0) {
    const halo = ctx.createRadialGradient(0, 0, R * 0.5, 0, 0, R * 2.6);
    halo.addColorStop(0, rgba(look.core, look.halo));
    halo.addColorStop(0.45, rgba(look.core, look.halo * 0.3));
    halo.addColorStop(1, rgba(look.core, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(-c, -c, extent, extent);
  }

  // Orbiting things behind the sphere.
  const particles = frame.state === 'tool' && frame.moving ? frame.particles : 0;
  const drawParticles = (front: boolean) => {
    for (let i = 0; i < particles; i++) {
      const angle = frame.time * 2.1 + (i * TAU) / particles;
      const p = orbit(angle, R * 1.5, 0.42);
      if (p.depth > 0 !== front) continue;
      const r = Math.max(1.2, unit * (1.7 + 0.5 * p.depth));
      const a = 0.6 + 0.4 * p.depth;
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
      glow.addColorStop(0, rgba(palette.family, 0.4 * a));
      glow.addColorStop(1, rgba(palette.family, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(p.x - r * 3, p.y - r * 3, r * 6, r * 6);
      ctx.fillStyle = rgba(mix(palette.family, WHITE, 0.25), a);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
    }
  };
  const satellites = frame.state === 'ended' ? 0 : frame.satellites;
  const drawSatellites = (front: boolean) => {
    for (let i = 0; i < satellites; i++) {
      const base = (i * TAU) / satellites + 0.6;
      const angle = frame.moving ? frame.time * -0.8 + base : base;
      const p = orbit(angle, R * 1.85, 0.5);
      if (p.depth > 0 !== front) continue;
      const r = Math.max(1.6, R * 0.2);
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.4);
      glow.addColorStop(0, rgba(palette.satellite, 0.35));
      glow.addColorStop(1, rgba(palette.satellite, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(p.x - r * 2.4, p.y - r * 2.4, r * 4.8, r * 4.8);
      const body = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.35, 0, p.x, p.y, r);
      body.addColorStop(0, rgba(mix(palette.satellite, WHITE, 0.45), 1));
      body.addColorStop(1, rgba(mix(palette.satellite, BLACK, 0.25), 1));
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
    }
  };
  drawParticles(false);
  drawSatellites(false);

  // Inward drift while compacting.
  if (frame.state === 'compacting' && frame.moving) {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const phase = (frame.time * 0.7 + i / n) % 1;
      const angle = (i * TAU) / n + frame.time * 0.3;
      const dist = R * (2 - phase);
      ctx.fillStyle = rgba(mix(look.core, WHITE, 0.3), Math.sin(phase * Math.PI) * 0.8);
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * dist, Math.sin(angle) * dist, Math.max(0.8, unit), 0, TAU);
      ctx.fill();
    }
  }

  // Sphere body: a lit core falling off to a dark limb.
  ctx.globalAlpha = look.alpha;
  const body = ctx.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.05, 0, 0, R);
  body.addColorStop(0, rgba(mix(look.core, WHITE, look.light), 1));
  body.addColorStop(0.55, rgba(look.core, 1));
  body.addColorStop(1, rgba(mix(look.core, palette.light ? look.core : BLACK, 0.55), 1));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.fill();

  // Internal swirl: two soft lobes counter-rotating inside the sphere.
  if (frame.state === 'working' || frame.state === 'tool' || frame.state === 'compacting') {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.clip();
    ctx.globalCompositeOperation = palette.light ? 'source-over' : 'lighter';
    const speed = frame.state === 'working' ? 1.5 : 0.9;
    const angles = frame.moving ? [frame.time * speed, -frame.time * speed * 0.62 + 2] : [0.8, 3.6];
    for (const [i, angle] of angles.entries()) {
      const x = Math.cos(angle) * R * 0.42;
      const y = Math.sin(angle) * R * 0.42;
      const lobe = ctx.createRadialGradient(x, y, 0, x, y, R * (0.8 - i * 0.15));
      const tint = mix(look.core, i === 0 ? WHITE : palette.accent, i === 0 ? 0.4 : 0.5);
      lobe.addColorStop(0, rgba(tint, palette.light ? 0.4 : 0.32));
      lobe.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = lobe;
      ctx.fillRect(-R, -R, R * 2, R * 2);
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  // Rim: the faint accent edge that keeps identity visible.
  ctx.strokeStyle = rgba(frame.state === 'ended' ? grey(palette.accent) : palette.accent, look.rim);
  ctx.lineWidth = Math.max(0.75, unit * 0.9);
  ctx.beginPath();
  ctx.arc(0, 0, R - ctx.lineWidth / 2, 0, TAU);
  ctx.stroke();

  drawParticles(true);
  drawSatellites(true);

  const ringRadius = R + Math.max(2.5, unit * 3.5);
  const ringWidth = Math.max(1.25, unit * 1.5);

  // Waiting: a static ring, or the countdown filling clockwise.
  if (frame.state === 'waiting') {
    ctx.lineWidth = ringWidth;
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(look.core, frame.countdown === null ? 0.5 : 0.18);
    ctx.beginPath();
    ctx.arc(0, 0, ringRadius, 0, TAU);
    ctx.stroke();
    if (frame.countdown !== null && frame.countdown > 0) {
      ctx.strokeStyle = rgba(look.core, 0.95);
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius, -Math.PI / 2, -Math.PI / 2 + TAU * frame.countdown);
      ctx.stroke();
    }
  }

  // Shape cues so status never relies on color alone (DESIGN.md §8).
  if (frame.size >= 36 && (frame.state === 'waiting' || frame.state === 'error')) {
    const g = R * 0.32;
    ctx.strokeStyle = rgba(palette.light ? WHITE : palette.base, 0.85);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = Math.max(1.5, R * 0.13);
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (frame.state === 'error') {
      ctx.moveTo(-g, -g);
      ctx.lineTo(g, g);
      ctx.moveTo(g, -g);
      ctx.lineTo(-g, g);
      ctx.stroke();
    } else {
      ctx.moveTo(0, -g * 1.2);
      ctx.lineTo(0, g * 0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, g * 1.1, ctx.lineWidth * 0.55, 0, TAU);
      ctx.fill();
    }
  }

  if (effect?.kind === 'ripple') {
    const e = easeOut(clamp01(effect.time / EFFECT_DURATION.ripple));
    ctx.strokeStyle = rgba(look.core, 0.6 * (1 - e));
    ctx.lineWidth = ringWidth;
    ctx.beginPath();
    ctx.arc(0, 0, R * (1 + 0.6 * e), 0, TAU);
    ctx.stroke();
  }

  if (effect?.kind === 'sweep') {
    // The completion check: a green arc sweeping once around the orb, then gone.
    const k = clamp01(effect.time / EFFECT_DURATION.sweep);
    const head = -Math.PI / 2 + TAU * easeOut(k);
    const fade = 1 - k * k;
    ctx.lineWidth = ringWidth;
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(palette.ok, 0.9 * fade);
    ctx.beginPath();
    ctx.arc(0, 0, ringRadius, Math.max(-Math.PI / 2, head - 1.4), head);
    ctx.stroke();
    const tint = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    tint.addColorStop(0, rgba(palette.ok, 0.35 * fade));
    tint.addColorStop(1, rgba(palette.ok, 0));
    ctx.fillStyle = tint;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}
