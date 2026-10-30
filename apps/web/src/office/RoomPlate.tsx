import { motion } from 'motion/react';
import { Link } from 'wouter';
import type { SceneActor } from '../layouts/scene.js';
import { dur, ease, spring } from '../motion.js';
import { StatusDot } from '../ui/StatusDot.js';
import { FLOOR, type Plate } from './room.js';

/** One line's height; a couch's two names start higher, a single one leaves the feet clear. */
const LINE_PX = 16;
const SINGLE_TOP = FLOOR + 14;
const STACK_TOP = FLOOR + 2;
/** Text never drops below this on screen, however small the room is drawn (§10.1). */
const MIN_TEXT_PX = 12;

/**
 * A station's name plate on the floor: who works there, with their status mark, sliding with the
 * station. The name leads to the focus view; the character itself opens the Actor inspector, like
 * a session row and its crew. Touch keeps plain text, since one tap on the character gets there.
 */
export function RoomPlate({
  plate,
  actors,
  fit,
  linked,
}: {
  plate: Plate;
  actors: ReadonlyMap<string, SceneActor>;
  /** The room's drawing scale. */
  fit: number;
  linked: boolean;
}) {
  const stack = plate.actorIds.length > 1 && plate.key.startsWith('couch');
  const lines = stack ? plate.actorIds : plate.actorIds.slice(0, 1);
  const extra = plate.actorIds.length - lines.length;
  return (
    <motion.div
      data-office-plate={plate.key}
      className="absolute top-0 left-0 z-20 flex flex-col"
      style={{
        top: stack ? STACK_TOP : SINGLE_TOP,
        width: plate.w,
        fontSize: MIN_TEXT_PX / Math.min(1, fit),
      }}
      initial={{ opacity: 0, x: plate.x }}
      animate={{ opacity: 1, x: plate.x }}
      transition={{ x: spring.smooth, opacity: { duration: dur.base, ease: ease.out } }}
    >
      {lines.map((id) => {
        const actor = actors.get(id);
        if (!actor) return null;
        const name = (
          <>
            {actor.tone !== 'idle' && <StatusDot tone={actor.tone} label={actor.label} />}
            <span className="min-w-0 truncate">
              {actor.label}
              {extra > 0 && ` +${extra}`}
            </span>
          </>
        );
        const line = {
          title: actor.label,
          'data-tone': actor.tone,
          className: 'office-plate-line',
          style: { height: LINE_PX },
        };
        return linked ? (
          <Link
            key={id}
            href={actor.links.href}
            tabIndex={-1}
            aria-label={`Open ${actor.label}`}
            data-office-open={id}
            {...line}
          >
            {name}
          </Link>
        ) : (
          <span key={id} {...line}>
            {name}
          </span>
        );
      })}
    </motion.div>
  );
}
