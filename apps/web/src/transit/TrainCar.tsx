import { type CSSProperties, useEffect, useRef } from 'react';
import type { SceneActor } from '../layouts/scene.js';
import { dur, ease, useMotionLevel } from '../motion.js';
import { cx } from '../ui/cx.js';
import { TRAIN, TRAIN_AT, type TrainMotion } from './map.js';

/**
 * A train standing past its station mark (DESIGN.md §10.5). It pulls out when its work starts and
 * rolls back to the platform when it ends: Full glides there (CSS, `dur.slow`), Reduced
 * cross-fades into the new place, Off just stands there.
 */
export function TrainCar({
  kind,
  motion,
  mini = false,
  className,
}: {
  kind: SceneActor['kind'];
  motion: TrainMotion;
  mini?: boolean;
  className?: string;
}) {
  const level = useMotionLevel();
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(motion);
  useEffect(() => {
    const moved = TRAIN_AT[last.current] !== TRAIN_AT[motion];
    last.current = motion;
    if (!moved || level !== 'reduced') return;
    ref.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: dur.base * 1000,
      easing: `cubic-bezier(${ease.out.join(',')})`,
    });
  }, [motion, level]);
  return (
    <span
      ref={ref}
      aria-hidden
      data-train={motion}
      className={cx('transit-car-slot', className)}
      style={{ '--train-at': `${mini ? 0 : TRAIN_AT[motion]}px` } as CSSProperties}
    >
      <TrainBody
        kind={kind}
        motion={motion}
        len={mini ? TRAIN.miniLen : TRAIN.len}
        thick={mini ? TRAIN.miniThick : TRAIN.thick}
      />
    </span>
  );
}

/**
 * A rounded car facing the future: its windows take the state's tone, a working one trails speed
 * lines, a waiting one has amber doors that pulse, an errored one is rose with a "!" for windows.
 * Claude trains carry a round headlight, terminals a square one.
 */
function TrainBody({
  kind,
  motion,
  len,
  thick,
}: {
  kind: SceneActor['kind'];
  motion: TrainMotion;
  len: number;
  thick: number;
}) {
  const x = -len / 2;
  const y = -thick / 2;
  const windows = Math.max(1, Math.floor((len - 10) / 7));
  return (
    <svg
      aria-hidden
      className="transit-car overflow-visible"
      viewBox={`${x} ${y} ${len} ${thick}`}
      width={len}
      height={thick}
    >
      {motion === 'glide' && len >= TRAIN.len && (
        <g className="transit-trail">
          <rect x={x - 18} y={-1.5} width={18} height={3} rx={1.5} className="transit-trail-glow" />
          <g className="transit-speed">
            {[0, 8, 16].map((d) => (
              <line
                key={d}
                className="transit-speed-line"
                x1={x - 4 - d}
                x2={x - 8 - d}
                y1={y + 2}
                y2={y + 2}
              />
            ))}
            {[4, 12].map((d) => (
              <line
                key={d}
                className="transit-speed-line"
                x1={x - 4 - d}
                x2={x - 8 - d}
                y1={-y - 2}
                y2={-y - 2}
              />
            ))}
          </g>
        </g>
      )}
      <rect className="transit-body" x={x} y={y} width={len} height={thick} rx={thick / 2.6} />
      {motion === 'stop' ? (
        <path
          className="transit-alert"
          d={`M0 ${y + 3} L0 ${-y - 5.5} M0 ${-y - 3.2} L0 ${-y - 3}`}
        />
      ) : (
        Array.from({ length: windows }, (_, i) => (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed windows in a fixed car
            key={i}
            className="transit-window"
            x={x + 3.5 + i * 7}
            y={y + thick * 0.28}
            width={4.5}
            height={thick * 0.44}
            rx={1}
          />
        ))
      )}
      {motion === 'wait' && (
        <g className="transit-doors">
          <rect x={-2.5} y={y + 1.5} width={2} height={thick - 3} />
          <rect x={0.5} y={y + 1.5} width={2} height={thick - 3} />
        </g>
      )}
      {kind === 'terminal' ? (
        <rect className="transit-light" x={-x - 4.5} y={-1.5} width={3} height={3} />
      ) : (
        <circle className="transit-light" cx={-x - 3} cy={0} r={1.6} />
      )}
    </svg>
  );
}
