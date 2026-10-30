import { toolFamily } from '@yardmaster/protocol';
import { AnimatePresence, motion } from 'motion/react';
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SceneActor, SceneProject } from '../layouts/scene.js';
import { dur, ease, spring } from '../motion.js';
import { FAMILY_TOKEN } from '../orb/model.js';
import { PodMenu } from '../pod/PodMenu.js';
import { useMediaQuery } from '../prefs.js';
import { projectHref } from '../routes.js';
import { toneLabel } from '../status.js';
import { cx } from '../ui/cx.js';
import { Bookshelf, Couch, Desk, ServerRack, SideDesk, Workbench } from './kit/furniture.js';
import { PortSign } from './kit/PortSign.js';
import { type DoorLight, RoomShell } from './kit/RoomShell.js';
import { Whiteboard } from './kit/Whiteboard.js';
import { OfficeCharacter } from './OfficeCharacter.js';
import { RoomPlate } from './RoomPlate.js';
import {
  FLOOR,
  FURNITURE_SCALE,
  type PlacedStation,
  planRoom,
  ROOM_HEIGHT,
  rackTagClear,
  roomPlates,
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
  /** This room is the one the room view shows. */
  entered?: boolean;
  /** A click on the room (not on a character) or Enter on it: the room view. */
  onEnter?(projectId: string): void;
  /** The scale the room is drawn at (a phone's room is scaled down to fit). */
  fit?: number;
}

/**
 * One project's room in the building (DESIGN.md §10.3): the shell with door light, nameplate and
 * ceiling light, the whiteboard and port sign, a station per actor and everyone at theirs.
 * Memoized: the scene keeps an unchanged project's object, so a busy room doesn't redraw the rest.
 */
export const OfficeRoom = memo(function OfficeRoom({
  project,
  width,
  now,
  entered = false,
  onEnter,
  fit = 1,
}: OfficeRoomProps) {
  const work = useRef<ReadonlyMap<string, WorkStation>>(new Map());
  // The character under the pointer and the focused one hold still while you read their name
  // tag: they wait to walk, and a crowded room hides someone else.
  const [pointed, setPointed] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const hold = useMemo(
    () => new Set([pointed, focused].filter((id): id is string => id !== null)),
    [pointed, focused],
  );
  const plan = useMemo(
    () => planRoom(project.actors, { width, now, previous: work.current, hold }),
    [project.actors, width, now, hold],
  );
  useEffect(() => {
    work.current = plan.work;
  }, [plan]);

  const coarse = useMediaQuery('(pointer: coarse)');
  const actors = useMemo(() => new Map(project.actors.map((a) => [a.id, a])), [project.actors]);
  const whiteboard = project.todos.length > 0 || Boolean(project.summary);
  // The main session (the oldest) wears the project's accent; everyone else the status colors.
  const main = project.actors
    .filter((a) => a.kind === 'claude')
    .sort((a, b) => a.since - b.since)[0]?.id;
  const accent = `var(--accent-${project.accent})`;
  const placements = [...plan.placements].sort((a, b) => Number(a.front) - Number(b.front));

  // The room is one Tab stop; arrow keys move into and between its characters, Enter on the
  // room opens the room view, Esc on a character goes back to the room (§10.1).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const room = event.currentTarget;
    if (!room.contains(event.target as Node)) return;
    if (event.target === room) {
      if (event.key === 'Enter' && !entered && onEnter) {
        event.preventDefault();
        onEnter(project.id);
        return;
      }
    } else if (event.key === 'Escape' && !entered && !event.defaultPrevented) {
      event.preventDefault();
      room.focus({ preventScroll: true });
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const buttons = [...room.querySelectorAll<HTMLElement>('[data-scene-actor]')].sort(
      (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left,
    );
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    const next = index < 0 ? (step > 0 ? 0 : buttons.length - 1) : index + step;
    buttons[(next + buttons.length) % buttons.length]?.focus({ preventScroll: true });
  };

  // Events from the inspector bubble here through its portal: those leave the hold as it is.
  const actorAt = (target: EventTarget) =>
    (target as Element).closest('[data-scene-actor]')?.getAttribute('data-scene-actor') ?? null;
  const onPointerOver = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse' || !event.currentTarget.contains(event.target as Node))
      return;
    setPointed(actorAt(event.target));
  };
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.target)) setFocused(actorAt(event.target));
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next && (event.currentTarget.contains(next) || next.closest('[data-actor-inspector]')))
      return;
    setFocused(null);
  };

  // Anywhere in the room but a character or a control opens the room view. Clicks inside an
  // inspector bubble here through its portal; those stay out.
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (!onEnter) return;
    const target = event.target as Element;
    if (!event.currentTarget.contains(target)) return;
    if (target.closest('button, a, [data-scene-actor]')) return;
    onEnter(project.id);
  };

  return (
    <PodMenu project={project}>
      <section
        aria-roledescription="room"
        aria-label={`${project.name}, ${toneLabel(project.tone)}`}
        aria-keyshortcuts={entered ? undefined : 'Enter'}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: each room is one Tab stop (§10.1).
        tabIndex={0}
        data-room={project.id}
        data-room-entered={entered || undefined}
        data-focus-return={entered ? undefined : project.id}
        data-tone={project.tone}
        data-dim={project.dim || undefined}
        onKeyDown={onKeyDown}
        onPointerOver={onPointerOver}
        onPointerLeave={() => setPointed(null)}
        onFocus={onFocus}
        onBlur={onBlur}
        onClick={entered ? undefined : onClick}
        className={cx(
          'office-room relative outline-none focus-visible:ring-2 focus-visible:ring-line-strong focus-visible:ring-inset',
          !entered && onEnter && 'cursor-pointer',
        )}
        style={{ width, height: ROOM_HEIGHT }}
      >
        <RoomShell
          project={project}
          href={coarse ? undefined : projectHref(project.id)}
          branch={project.branch}
          dirty={project.dirty}
          doorLight={DOOR_LIGHT[project.tone] ?? 'off'}
          light={Math.max(project.activity, ...project.actors.map((a) => a.activity))}
          dim={project.dim}
          w={width}
          h={ROOM_HEIGHT}
        >
          {whiteboard && (
            <div className="absolute" style={{ left: WHITEBOARD.x, top: WHITEBOARD.y }}>
              <Whiteboard
                items={project.todos}
                summary={project.summary}
                scale={WHITEBOARD.scale}
              />
            </div>
          )}
          {project.ports.length > 0 && (
            <div
              className="absolute flex justify-end"
              style={{ right: 8, top: 6, maxWidth: width * 0.4 }}
            >
              <PortSign ports={project.ports} interactive />
            </div>
          )}

          <AnimatePresence initial={false}>
            {plan.stations.map((station) => (
              <StationSlot key={station.key} station={station}>
                <StationArt
                  station={station}
                  owner={station.owner ? actors.get(station.owner) : undefined}
                  whiteboard={whiteboard}
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
                  fit={fit}
                  held={hold.has(actor.id)}
                />
              );
            })}
          </AnimatePresence>

          {roomPlates(plan).map((plate) => (
            <RoomPlate key={plate.key} plate={plate} actors={actors} fit={fit} linked={!coarse} />
          ))}

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
    </PodMenu>
  );
});

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

function StationArt({
  station,
  owner,
  whiteboard,
}: {
  station: PlacedStation;
  owner?: SceneActor;
  whiteboard: boolean;
}) {
  const scale = FURNITURE_SCALE;
  switch (station.kind) {
    case 'desk':
      return <Desk scale={scale} {...screenFor(owner)} />;
    case 'side-desk':
      return <SideDesk scale={scale} />;
    case 'rack':
      return (
        <ServerRack
          scale={scale}
          rate={owner?.activity ?? 0}
          ports={rackTagClear(station.x + RACK_OFFSET, whiteboard) ? (owner?.ports ?? []) : []}
        />
      );
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
