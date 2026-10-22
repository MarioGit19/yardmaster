import { useRef } from 'react';
import { FIELD_PALETTES, type FieldFrame, type FieldRenderer } from '../ambient/renderer.js';
import { approach } from '../ambient/signal.js';
import { createQuadProgram } from './gl.js';
import { ShaderStage, type StageEffect } from './ShaderStage.js';

/** Where a boxed field puts its attention bloom (the ambient field follows the waiting pod). */
const BLOOM = { x: 0.78, y: 0.22 };

/**
 * An ambient style's shader as a `FieldRenderer`, fed exactly like the nebula: the fragment takes
 * `uRes`, `uTime`, `uEnergy`, `uAttention`, `uAttnPos` and the palette (`uBase`, `uDeep`,
 * `uViolet`, `uAmber`, `uGain`).
 */
export function fieldRenderer(gl: WebGL2RenderingContext, fragment: string): FieldRenderer | null {
  const program = createQuadProgram(gl, fragment);
  if (!program) return null;
  const { u } = program;
  const at = (name: string) => u[name] ?? null;
  return {
    draw(frame: FieldFrame) {
      if (gl.isContextLost()) return;
      const canvas = gl.canvas;
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      program.use(frame.width, frame.height);
      gl.uniform2f(at('uRes'), frame.width, frame.height);
      gl.uniform1f(at('uTime'), frame.time);
      gl.uniform1f(at('uEnergy'), frame.energy);
      gl.uniform1f(at('uAttention'), frame.attention);
      gl.uniform2f(at('uAttnPos'), frame.attentionX, frame.attentionY);
      gl.uniform3fv(at('uBase'), frame.palette.base);
      gl.uniform3fv(at('uDeep'), frame.palette.deep);
      gl.uniform3fv(at('uViolet'), frame.palette.violet);
      gl.uniform3fv(at('uAmber'), frame.palette.amber);
      gl.uniform1f(at('uGain'), frame.palette.gain);
      program.draw();
    },
    dispose: program.dispose,
  };
}

/**
 * A field renderer (`createVeil`, `createAurora`) as a stage effect: energy and attention ease like
 * the ambient field's, and time integrates speed so the flow never jumps when energy changes.
 */
export function fieldStageEffect(
  renderer: FieldRenderer,
  input: { readonly current: { energy: number; attention: number } },
): StageEffect {
  let time = 3;
  let energy = input.current.energy;
  let attention = input.current.attention;
  return {
    draw(frame) {
      const ms = frame.dt * 1000;
      const goal = input.current;
      energy = frame.still ? goal.energy : approach(energy, goal.energy, ms, 1400);
      attention = frame.still ? goal.attention : approach(attention, goal.attention, ms, 900);
      time += frame.dt * (0.012 + 0.11 * energy);
      renderer.draw({
        width: frame.width,
        height: frame.height,
        time,
        energy,
        attention,
        attentionX: BLOOM.x,
        attentionY: BLOOM.y,
        palette: FIELD_PALETTES[frame.theme],
      });
    },
    dispose: renderer.dispose,
  };
}

export interface FieldEffectProps {
  /** 0..1, the board's activity (the ambient field's `uEnergy`). */
  energy: number;
  /** 0..1, the amber bloom toward a waiting project. */
  attention?: number;
  className?: string;
}

/** An ambient-style field in a box, at the ambient field's half resolution. */
export function FieldStage({
  energy,
  attention = 0,
  className,
  create,
}: FieldEffectProps & { create(gl: WebGL2RenderingContext): FieldRenderer | null }) {
  const input = useRef({ energy, attention });
  input.current = { energy, attention };
  return (
    <ShaderStage
      className={className}
      resolution={0.5}
      stillKey={`${energy}:${attention}`}
      fallback={<div className="ambient-css size-full" />}
      create={(gl) => {
        const renderer = create(gl);
        return renderer && fieldStageEffect(renderer, input);
      }}
    />
  );
}
