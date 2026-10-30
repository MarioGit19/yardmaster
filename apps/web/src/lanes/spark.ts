import { CPU_SAMPLE_EVERY, SAMPLE_MS, SAMPLES, type SampleRing } from './throughput.js';

/** Bytes per sample that fill an output tick; about 800 log lines a second. Never auto-scaled. */
export const OUTPUT_TOP = 65_536;
/** Log-scale knee: a single short log line already shows, a build log doesn't clip. */
const KNEE = 32;

/** 0..1 height for an output sample, on the same fixed scale for every terminal. */
export function outputLevel(value: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.log1p(value / KNEE) / Math.log1p(OUTPUT_TOP / KNEE));
}

/** The CPU axis, percent. Multi-core work above it pins to the top; the text keeps the number. */
export const CPU_TOP = 100;
/** Points the CPU has to move inside the window before a line says anything: 2.4 px of 24. */
export const CPU_VARIES = 10;
/** Samples before a line can be drawn: 2 min, 40% of the window, so it's a line and not a speck. */
export const CPU_MIN_SAMPLES = 24;
/** Below this a terminal counts as idle, not as "1%". */
export const CPU_SHOWN = 2;
/** Newest samples that must all be idle before the value leaves, so it doesn't blink at 2%. */
const CPU_SETTLE = 3;

export const CPU_WINDOW_MS = SAMPLES * CPU_SAMPLE_EVERY * SAMPLE_MS;
export const OUTPUT_WINDOW_MS = SAMPLES * SAMPLE_MS;

/** A window's short label, as the card's other durations: "5m". */
export const windowLabel = (ms: number) => `${Math.round(ms / 60_000)}m`;

export type LaneSignal =
  /** CPU moved inside its window: a line on the fixed axis. */
  | { kind: 'line'; cpu: number }
  /** Output arrived inside its window: one tick per sample that saw any. */
  | { kind: 'ticks' }
  /** Nothing to plot, but the terminal is at work: the current CPU as text. */
  | { kind: 'value'; cpu: number }
  | { kind: 'none' };

/** Whether the CPU series has enough samples, and enough range on its axis, to plot. */
export function cpuVaries(cpu: SampleRing): boolean {
  if (cpu.filled < CPU_MIN_SAMPLES) return false;
  let low = CPU_TOP;
  let high = 0;
  for (let i = SAMPLES - cpu.filled; i < SAMPLES; i++) {
    const value = Math.min(CPU_TOP, cpu.at(i));
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return high - low >= CPU_VARIES;
}

/** What a lane's graph track says right now. `running`: a command is running in the terminal. */
export function laneSignal(output: SampleRing, cpu: SampleRing, running: boolean): LaneSignal {
  const current = Math.round(cpu.at(SAMPLES - 1));
  if (cpuVaries(cpu)) return { kind: 'line', cpu: current };
  if (output.max() > 0) return { kind: 'ticks' };
  if (running) {
    for (let age = 0; age < Math.min(CPU_SETTLE, cpu.filled); age++) {
      if (cpu.at(SAMPLES - 1 - age) >= CPU_SHOWN) return { kind: 'value', cpu: current };
    }
  }
  return { kind: 'none' };
}

export const sameSignal = (a: LaneSignal, b: LaneSignal) =>
  a.kind === b.kind && (a as { cpu?: number }).cpu === (b as { cpu?: number }).cpu;

/** Room right of the plot and above it for the end dot and its halo, px. */
export const HEAD_ROOM = 5;

/** The horizontal distance between two samples, for a graph `width` px wide. */
export const sparkStep = (width: number) => width / (SAMPLES - 2);

/**
 * Canvas points for the CPU ring's filled samples, the newest at the end. It sits one step past
 * `width`, so sliding the canvas left by one step over a sample period reveals it.
 */
export function cpuPoints(
  cpu: SampleRing,
  width: number,
  height: number,
  inset = 1.5,
): Array<[number, number]> {
  const step = sparkStep(width);
  const span = Math.max(0, height - inset * 2);
  const points: Array<[number, number]> = [];
  for (let i = SAMPLES - cpu.filled; i < SAMPLES; i++) {
    const level = Math.min(CPU_TOP, cpu.at(i)) / CPU_TOP;
    points.push([i * step, height - inset - level * span]);
  }
  return points;
}

/** Shortest tick that still reads as a mark, px. */
const TICK_MIN = 3;

/** One `{x, height}` per output sample that saw any, with the same one-step lead as the line. */
export function outputTicks(
  output: SampleRing,
  width: number,
  height: number,
): Array<{ x: number; height: number }> {
  const step = sparkStep(width);
  const ticks: Array<{ x: number; height: number }> = [];
  for (let i = 0; i < SAMPLES; i++) {
    const level = outputLevel(output.at(i));
    if (level > 0) ticks.push({ x: i * step, height: TICK_MIN + level * (height - TICK_MIN) });
  }
  return ticks;
}
