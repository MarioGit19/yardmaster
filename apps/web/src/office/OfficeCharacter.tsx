import { animate, motion, useMotionValue } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { CrewMascot } from '../crew/CrewMascot.js';
import type { MascotState } from '../crew/model.js';
import { ActorInspector } from '../layouts/ActorInspector.js';
import type { OpsState, SceneActor } from '../layouts/scene.js';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
import { cx } from '../ui/cx.js';
import { OpsMascot } from './OpsMascot.js';
import { opsMascotState } from './ops.js';
import { type Placement, walkSeconds } from './room.js';

/** Tap targets stay at least this big, even around a mini crew member (§10.1). */
const TAP_PX = 44;
/** The door's middle, in room units (kit/RoomShell.tsx). */
const DOOR_X = 34;

export interface OfficeCharacterProps {
  actor: SceneActor;
  placement: Placement;
  projectName: string;
  /** Visor color: the project accent for the main session, else the status colors. */
  color?: string;
}

/**
 * One character in an Office room: its mascot at its spot, a button that opens the Actor
 * inspector, and a name tag with the live caption on hover or focus. A new spot is a walk along
 * the floor (600–900 ms, legs swinging) at Full, a cross-fade at Reduced, a jump at Off.
 */
export function OfficeCharacter({ actor, placement, projectName, color }: OfficeCharacterProps) {
  const level = useMotionLevel();
  const left = placement.x - placement.size / 2;
  const top = placement.y - placement.size;
  const x = useMotionValue(left);
  const y = useMotionValue(top);
  const opacity = useMotionValue(1);
  const [walking, setWalking] = useState(false);
  const levelRef = useRef(level);
  levelRef.current = level;

  useEffect(() => {
    const dx = left - x.get();
    const dy = top - y.get();
    if (dx === 0 && dy === 0) return;
    if (levelRef.current === 'off') {
      x.set(left);
      y.set(top);
      return;
    }
    if (levelRef.current === 'reduced') {
      // Fade out where it was, appear where it goes.
      const out = animate(opacity, 0, { duration: dur.base, ease: ease.out });
      let back: { stop(): void } | null = null;
      out.then(() => {
        x.set(left);
        y.set(top);
        back = animate(opacity, 1, { duration: dur.base, ease: ease.out });
      });
      return () => {
        out.stop();
        back?.stop();
        x.set(left);
        y.set(top);
        opacity.set(1);
      };
    }
    const seconds = walkSeconds(Math.hypot(dx, dy));
    setWalking(true);
    const walkX = animate(x, left, { duration: seconds, ease: ease.inOut });
    const walkY = animate(y, top, { duration: seconds, ease: ease.inOut });
    walkX.then(() => setWalking(false));
    return () => {
      walkX.stop();
      walkY.stop();
      setWalking(false);
    };
  }, [left, top, x, y, opacity]);

  const hit = Math.max(TAP_PX, placement.size);
  const mini = actor.parentId !== null;
  const facing = walking ? Math.sign(left - x.get()) : 0;

  return (
    <motion.div
      data-office-actor={actor.id}
      data-office-at={placement.at}
      data-walking={walking || undefined}
      className={cx('office-actor absolute top-0 left-0', placement.front && 'z-10')}
      style={{ x, y, opacity, width: placement.size, height: placement.size }}
      // Mini crew pop in at the side desk and walk out of the door when they finish (§10.3).
      initial={mini ? { opacity: 0, scale: 0.4 } : { opacity: 0 }}
      animate={{ opacity: 1, scale: 1, transition: mini ? spring.snappy : { duration: dur.base } }}
      exit={
        mini
          ? {
              x: DOOR_X - placement.size / 2,
              opacity: [1, 1, 0],
              transition: { duration: walkSeconds(left - DOOR_X), ease: ease.inOut },
            }
          : { opacity: 0, transition: { duration: dur.fast, ease: ease.out } }
      }
    >
      <ActorInspector
        projectId={actor.projectId}
        actorId={actor.id}
        label={`${projectName}, ${actor.label}`}
        trigger={
          <button
            type="button"
            // The room is the Tab stop; arrow keys move between its characters (§10.1).
            tabIndex={-1}
            aria-label={actor.name}
            data-scene-actor={actor.id}
            data-actor-state={actor.state}
            className="group absolute rounded-control outline-none focus-visible:ring-2 focus-visible:ring-line-strong"
            style={{
              width: hit,
              height: hit,
              left: (placement.size - hit) / 2,
              top: placement.size - hit,
            }}
          >
            <span
              className="absolute bottom-0 left-1/2 -translate-x-1/2"
              style={{ width: placement.size, height: placement.size }}
            >
              <span
                className="office-face absolute inset-0"
                data-facing={facing < 0 ? 'left' : undefined}
              >
                <Mascot
                  actor={actor}
                  size={placement.size}
                  color={color}
                  drawing={placement.at === 'whiteboard'}
                />
              </span>
            </span>
            <span
              aria-hidden
              data-office-tag
              className="office-tag pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 flex max-w-56 -translate-x-1/2 items-baseline gap-1.5 whitespace-nowrap rounded-control border border-line bg-bg-1/95 px-2 py-1 shadow-raised"
            >
              <span className="truncate font-medium text-label text-text-1">{actor.label}</span>
              <span className="truncate text-label text-text-2">{actor.caption.text}</span>
            </span>
          </button>
        }
      />
    </motion.div>
  );
}

function Mascot({
  actor,
  size,
  color,
  drawing,
}: {
  actor: SceneActor;
  size: number;
  color?: string;
  drawing: boolean;
}) {
  switch (actor.kind) {
    case 'claude':
      return (
        <CrewMascot
          state={actor.state as MascotState}
          size={size}
          color={color}
          tool={actor.tool}
          activity={actor.activity}
          pose={drawing ? 'drawing' : undefined}
        />
      );
    case 'subagent':
      return <CrewMascot state="thinking" size={size} color={color} />;
    case 'background':
      return <OpsMascot state="running" size={size} activity={actor.activity} />;
    case 'terminal':
      return (
        <OpsMascot
          state={opsMascotState(actor.state as OpsState)}
          size={size}
          activity={actor.activity}
          exit={actor.exit}
        />
      );
  }
}
