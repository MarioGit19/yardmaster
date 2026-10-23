import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { activityKey } from '../data/activity.js';
import { useActivityStep, useDoneAt, useEventCount } from '../data/useActivity.js';
import { useMotionLevel } from '../motion.js';
import type { Tone } from '../status.js';
import { burstColor, type Point, packetFlow, segment } from './map.js';

/** Bursts are at least this far apart (a busy session doesn't strobe its pipeline). */
const BURST_GAP_MS = 600;
const BURST_PACKETS = 3;
const BURST_STAGGER_S = 0.09;

const PERIOD_VAR = ['--dur-packetCalm', '--dur-packetCalm', '--dur-packetBusy', '--dur-packetPeak'];

export interface PipelineProps {
  projectId: string;
  /** The core's end, and the node's. */
  from: Point;
  to: Point;
  /** How much of each end the core and the hexagon cover, px. */
  trimFrom: number;
  trimTo: number;
  tone: Tone;
  /** The busiest session's tool: its family colors the burst. */
  tool: string | null;
  /** The node is hovered or focused: its pipeline brightens. */
  hot?: boolean;
}

/**
 * One pipeline, DESIGN.md §10.4: a straight line that lights up while its project works, with
 * packets flowing out to the node at a rate that follows the project's activity, a short burst
 * per event in the tool family's color, and one green pulse back to the core when a turn ends.
 * A waiting node draws an amber pulse toward it every 2.4 s; an error turns the line rose with a
 * glitch. At Reduced and Off nothing travels: the line just lights up.
 */
export function Pipeline({
  projectId,
  from,
  to,
  trimFrom,
  trimTo,
  tone,
  tool,
  hot,
}: PipelineProps) {
  const key = activityKey.project(projectId);
  const step = useActivityStep(key);
  const events = useEventCount(key);
  const doneAt = useDoneAt(key);
  const moving = useMotionLevel() === 'full';
  const run = segment(from, to, trimFrom, trimTo);
  const flow = packetFlow(step);

  const [burst, setBurst] = useState<{ key: number; color: string } | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const seen = useRef({ events, doneAt, burstAt: 0 });
  const toolRef = useRef(tool);
  toolRef.current = tool;

  useEffect(() => {
    const last = seen.current;
    if (events === last.events) return;
    last.events = events;
    const now = performance.now();
    if (!moving || now - last.burstAt < BURST_GAP_MS) return;
    last.burstAt = now;
    setBurst({ key: events, color: burstColor(toolRef.current) });
  }, [events, moving]);

  useEffect(() => {
    const last = seen.current;
    if (doneAt === last.doneAt) return;
    last.doneAt = doneAt;
    if (moving && doneAt !== null) setDone(doneAt);
  }, [doneAt, moving]);

  const travel = { '--len': `${run.length}px` } as CSSProperties;
  const out = `translate(${run.x} ${run.y}) rotate(${run.angle})`;
  const rad = (run.angle * Math.PI) / 180;
  const back = `translate(${run.x + Math.cos(rad) * run.length} ${run.y + Math.sin(rad) * run.length}) rotate(${run.angle + 180})`;

  return (
    <g
      data-grid-pipe={projectId}
      data-tone={tone}
      data-step={step}
      data-hot={hot || undefined}
      className="grid-pipe"
    >
      <line
        className="grid-pipe-glow"
        x1={run.x}
        y1={run.y}
        x2={run.x + Math.cos(rad) * run.length}
        y2={run.y + Math.sin(rad) * run.length}
      />
      <line
        className="grid-pipe-line"
        x1={run.x}
        y1={run.y}
        x2={run.x + Math.cos(rad) * run.length}
        y2={run.y + Math.sin(rad) * run.length}
      />
      {moving && run.length > 0 && (
        <g transform={out} style={travel}>
          {Array.from({ length: flow.count }, (_, i) => (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: packets are positional.
              key={`${step}-${i}`}
              r={2.25}
              data-grid-packet
              className="grid-packet"
              style={
                {
                  '--packet-period': `var(${PERIOD_VAR[step]})`,
                  animationDelay: `${(-i * flow.period) / flow.count}s`,
                } as CSSProperties
              }
            />
          ))}
          {tone === 'wait' && <circle r={3} data-grid-beckon className="grid-beckon" />}
          {burst &&
            Array.from({ length: BURST_PACKETS }, (_, i) => (
              <circle
                // biome-ignore lint/suspicious/noArrayIndexKey: a burst's packets are positional.
                key={`${burst.key}-${i}`}
                r={2}
                data-grid-burst
                className="grid-burst"
                style={{ fill: burst.color, animationDelay: `${i * BURST_STAGGER_S}s` }}
                onAnimationEnd={i === BURST_PACKETS - 1 ? () => setBurst(null) : undefined}
              />
            ))}
        </g>
      )}
      {moving && done !== null && run.length > 0 && (
        <g transform={back} style={travel}>
          <circle
            key={done}
            r={3.25}
            data-grid-done
            className="grid-done"
            onAnimationEnd={() => setDone(null)}
          />
        </g>
      )}
    </g>
  );
}
