import { toolFamily } from '@c-board/protocol';
import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef } from 'react';
import type { SceneActor, SceneProject } from '../layouts/scene.js';
import { dur, ease, spring } from '../motion.js';
import { FAMILY_TOKEN } from '../orb/model.js';
import { toneLabel } from '../status.js';
import { Bookshelf, Couch, Desk, ServerRack, SideDesk, Workbench } from './kit/furniture.js';
import { PortSign } from './kit/PortSign.js';
import { type DoorLight, RoomShell } from './kit/RoomShell.js';
import { Whiteboard } from './kit/Whiteboard.js';
import { OfficeCharacter } from './OfficeCharacter.js';
import {
  FLOOR,
  FURNITURE_SCALE,
  type PlacedStation,
  planRoom,
  ROOM_HEIGHT,
  WHITEBOARD,
  type WorkStation,
} from './room.js';

/** Furniture heights in room units at scale 1, to stand each piece on the floor. */
const HEIGHT: Record<PlacedStation['kind'], number> = {
  desk: 50,
  'side-desk': 36,
  rack: 92,
  bench: 56,
  couch: 44,
  bookshelf: 92,
};
/** The rack's operator stands left of it (room.ts `RACK_STAND`). */
const RACK_OFFSET = 36;

const DOOR_LIGHT: Partial<Record<SceneProject['tone'], DoorLight>> = { wait: 'wait', err: 'err' };

const CAPTION_COLOR = { wait: 'var(--st-wait)', err: 'var(--st-err)' } as const;

/** The desk monitor: the tool family's color and the action's glyph (§10.3). */
function screenFor(actor: SceneActor | undefined): { screen: string | null; glyph: string | null } {
  if (!actor) return { screen: null, glyph: null };
  const { tone, glyph } = actor.caption;
  if (tone === 'wait' || tone === 'err') return { screen: CAPTION_COLOR[tone], glyph };
  if (tone !== 'active') return { screen: null, glyph: null };
  const family = actor.tool ? toolFamily(actor.tool) : null;
  return { screen: `var(${family ? FAMILY_TOKEN[family] : '--st-work'})`, glyph };
}

export interface OfficeRoomProps {
  project: SceneProject;
  /** Room width in px (= room units at scale 1). */
  width: number;
  now: number;
}

/**
 * One project's room in the building (DESIGN.md §10.3): the shell with door light, nameplate and
 * ceiling light, the whiteboard and port sign, a station per actor and everyone at theirs.
 */
export function OfficeRoom({ project, width, now }: OfficeRoomProps) {
  const work = useRef<ReadonlyMap<string, WorkStation>>(new Map());
  const plan = useMemo(
    () => planRoom(project.actors, { width, now, previous: work.current }),
    [project.actors, width, now],
  );
  useEffect(() => {
    work.current = plan.work;
  }, [plan]);

  const actors = useMemo(() => new Map(project.actors.map((a) => [a.id, a])), [project.actors]);
  // The main session (the oldest) wears the project's accent; everyone else the status colors.
  const main = project.actors
    .filter((a) => a.kind === 'claude')
    .sort((a, b) => a.since - b.since)[0]?.id;
  const accent = `var(--accent-${project.accent})`;
  const placements = [...plan.placements].sort((a, b) => Number(a.front) - Number(b.front));

  // Arrow keys move between the room's characters (§10.1).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLElement>('[data-scene-actor]'),
    ].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  };

  return (
    <section
      aria-label={`${project.name}, ${toneLabel(project.tone)}`}
      data-room={project.id}
      data-tone={project.tone}
      data-dim={project.dim || undefined}
      onKeyDown={onKeyDown}
      className="office-room relative"
      style={{ width, height: ROOM_HEIGHT }}
    >
      <RoomShell
        project={project}
        branch={project.branch}
        dirty={project.dirty}
        doorLight={DOOR_LIGHT[project.tone] ?? 'off'}
        light={Math.max(project.activity, ...project.actors.map((a) => a.activity))}
        dim={project.dim}
        w={width}
        h={ROOM_HEIGHT}
      >
        {(project.todos.length > 0 || project.summary) && (
          <div className="absolute" style={{ left: WHITEBOARD.x, top: WHITEBOARD.y }}>
            <Whiteboard items={project.todos} summary={project.summary} scale={WHITEBOARD.scale} />
          </div>
        )}
        {project.ports.length > 0 && (
          <div
            className="absolute flex justify-end"
            style={{ right: 8, top: 6, maxWidth: width * 0.4 }}
          >
            <PortSign ports={project.ports} />
          </div>
        )}

        <AnimatePresence initial={false}>
          {plan.stations.map((station) => (
            <StationSlot key={station.key} station={station}>
              <StationArt
                station={station}
                owner={station.owner ? actors.get(station.owner) : undefined}
              />
            </StationSlot>
          ))}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {placements.map((placement) => {
            const actor = actors.get(placement.actorId);
            if (!actor) return null;
            return (
              <OfficeCharacter
                key={actor.id}
                actor={actor}
                placement={placement}
                projectName={project.name}
                color={actor.id === main ? accent : undefined}
              />
            );
          })}
        </AnimatePresence>

        {plan.hidden > 0 && (
          <span
            role="img"
            aria-label={`${plan.hidden} more in ${project.name}`}
            data-room-more={plan.hidden}
            className="absolute grid h-6 min-w-8 place-items-center rounded-chip border border-line-strong bg-bg-1 px-1.5 font-mono text-label text-text-1 tabular shadow-raised"
            style={{ left: 34, top: 132, transform: 'translateX(-50%)' }}
          >
            +{plan.hidden}
          </span>
        )}
      </RoomShell>
    </section>
  );
}

/** A station stands on the floor and slides when the room's furniture shifts. */
function StationSlot({ station, children }: { station: PlacedStation; children: ReactNode }) {
  const height = HEIGHT[station.kind] * FURNITURE_SCALE;
  const offset = station.kind === 'rack' ? RACK_OFFSET : 0;
  return (
    <motion.div
      data-office-station={station.key}
      className="absolute top-0 left-0"
      style={{ top: FLOOR - height }}
      initial={{ opacity: 0, x: station.x + offset }}
      animate={{ opacity: 1, x: station.x + offset }}
      exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
      transition={{ x: spring.smooth, opacity: { duration: dur.base, ease: ease.out } }}
    >
      {children}
    </motion.div>
  );
}

function StationArt({ station, owner }: { station: PlacedStation; owner?: SceneActor }) {
  const scale = FURNITURE_SCALE;
  switch (station.kind) {
    case 'desk':
      return <Desk scale={scale} {...screenFor(owner)} />;
    case 'side-desk':
      return <SideDesk scale={scale} />;
    case 'rack':
      return <ServerRack scale={scale} rate={owner?.activity ?? 0} ports={owner?.ports ?? []} />;
    case 'bench':
      return (
        <Workbench scale={scale} running={owner?.state === 'running'} rate={owner?.activity ?? 0} />
      );
    case 'couch':
      return <Couch scale={scale} />;
    case 'bookshelf':
      return <Bookshelf scale={scale} />;
  }
}
