import { motion } from 'motion/react';
import type { CSSProperties } from 'react';
import { Link } from 'wouter';
import { ActorInspector } from '../layouts/ActorInspector.js';
import { actorKindName, type SceneActor, type SceneProject } from '../layouts/scene.js';
import { spring } from '../motion.js';
import { PodMenu } from '../pod/PodMenu.js';
import { projectHref } from '../routes.js';
import { toneLabel } from '../status.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import {
  boardStatus,
  type LineStation,
  lineStations,
  type ServiceEvent,
  slotCount,
  trainMotion,
} from './map.js';
import { ServiceLog } from './ServiceLog.js';
import { lineKeys, tipHandlers, useFresh, useTip } from './shared.js';
import { TrainCar } from './TrainCar.js';

/** A line's band on the desktop map, top to bottom: its sign, the stations, the spurs, the log. */
export const ROW = { height: 128, line: 62, stationTop: 30, spur: 86, logTop: 100, log: 22 };
/** The spur's 45° drop from the line, the mini trains it carries, and their spacing. */
const DROP = ROW.spur - ROW.line;
const MINIS = 2;
const MINI_STEP = 30;
/** A mini train's middle on the spur off the mark at `mark`. */
const miniAt = (mark: number, i: number) => mark + DROP + 20 + i * MINI_STEP;
/** The track's ends: a terminus bar at each, the stations between. */
const END = 6;
const FIRST = 20;

/** The line's initial in its roundel. */
export const initial = (name: string) => Array.from(name.trim())[0]?.toUpperCase() ?? '·';

export function Roundel({
  project,
  size = 24,
}: {
  project: Pick<SceneProject, 'accent' | 'name'>;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      className="transit-roundel"
      style={
        { '--route': `var(--accent-${project.accent})`, width: size, height: size } as CSSProperties
      }
    >
      {initial(project.name)}
    </span>
  );
}

/** The sign at the head of a line: roundel, name, branch and, when it needs you, why. */
export function LineSign({
  project,
  counts,
  className,
}: {
  project: SceneProject;
  counts: string;
  className?: string;
}) {
  return (
    <PodMenu project={project}>
      <Link
        href={projectHref(project.id)}
        data-transit-name={project.id}
        aria-label={`${project.name} line, ${toneLabel(project.tone)}, ${counts}. Arrow keys move through its stations and service log.`}
        className={cx(
          'transit-name group flex min-w-0 items-center gap-2.5 outline-none',
          className,
        )}
      >
        <Roundel project={project} />
        <span className="transit-name-text min-w-0 truncate" title={project.name}>
          {project.name}
        </span>
        {project.branch && (
          <span className="hidden min-w-0 truncate font-mono text-meta text-text-3 sm:inline">
            {project.branch}
          </span>
        )}
        {(project.tone === 'wait' || project.tone === 'err') && (
          <span className="transit-flag shrink-0" data-tone={project.tone}>
            <StatusDot tone={project.tone} label={toneLabel(project.tone)} />
            {project.tone === 'wait' ? 'Needs you' : 'Failed'}
          </span>
        )}
      </Link>
    </PodMenu>
  );
}

export const trainCount = (actors: readonly SceneActor[]) => {
  const n = actors.filter((a) => a.kind === 'claude' || a.kind === 'terminal').length;
  return `${n} ${n === 1 ? 'train' : 'trains'}`;
};

/**
 * DESIGN.md §10.5: one project as a line on the desktop map. Its sign heads the band; along the
 * track each session and terminal is a station with its sign and its train standing at the
 * platform (pulled out while it works), subagents ride a 45° spur off their session's station,
 * and the hour's service log runs underneath.
 */
export function TransitLine({
  project,
  order,
  width,
  busiest,
  now,
  events,
}: {
  project: SceneProject;
  /** The lines' order: a change glides each line to its new place (§3 rule 3). */
  order: string;
  width: number;
  /** The most stations any line on the map has. */
  busiest: number;
  now: number;
  events: readonly ServiceEvent[];
}) {
  const track = width - FIRST - END;
  const slots = slotCount(track, busiest);
  const slot = track / slots;
  const { stations, hidden } = lineStations(project.actors, slots);
  const fresh = useFresh(stations.map((s) => s.actor.id));
  const counts = trainCount(project.actors);
  const accent = `var(--accent-${project.accent})`;
  const x = (i: number) => FIRST + i * slot;

  return (
    <motion.li
      layout="position"
      layoutDependency={order}
      transition={{ layout: spring.smooth }}
      data-transit-line={project.id}
      data-tone={project.tone}
      data-dim={project.dim || undefined}
      data-scene-leaving={project.leaving}
      inert={project.leaving}
      onKeyDown={lineKeys}
      className="transit-line relative"
      style={{ '--route': accent, height: ROW.height } as CSSProperties}
    >
      <div className="flex h-7 min-w-0 items-center justify-between gap-3 pr-1">
        <LineSign project={project} counts={counts} />
        <span className="shrink-0 text-meta text-text-3 tabular">{counts}</span>
      </div>
      <svg
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 overflow-visible"
        width={width}
        height={ROW.height}
      >
        <line className="transit-track" x1={END} x2={width - END} y1={ROW.line} y2={ROW.line} />
        <line
          className="transit-terminus"
          x1={END}
          x2={END}
          y1={ROW.line - 10}
          y2={ROW.line + 10}
        />
        <line
          className="transit-terminus"
          x1={width - END}
          x2={width - END}
          y1={ROW.line - 10}
          y2={ROW.line + 10}
        />
        {stations.map(({ actor, minis }, i) =>
          minis.length > 0 ? (
            <polyline
              key={actor.id}
              data-transit-spur={actor.id}
              className="transit-spur"
              points={spurPoints(x(i) + 8, minis.length)}
            />
          ) : null,
        )}
      </svg>
      {stations.map((station, i) => (
        <Station
          key={station.actor.id}
          station={station}
          projectName={project.name}
          left={x(i)}
          slot={slot}
          fresh={fresh.has(station.actor.id)}
        />
      ))}
      {hidden > 0 && (
        <Link
          href={projectHref(project.id)}
          tabIndex={-1}
          data-transit-item
          data-transit-more={hidden}
          aria-label={`${hidden} more in ${project.name}: open the project`}
          className="transit-more absolute"
          style={{ left: x(stations.length), top: ROW.line - 12 }}
        >
          +{hidden}
        </Link>
      )}
      <ServiceLog
        events={events}
        now={now}
        width={width - END * 2}
        height={ROW.log}
        style={{ position: 'absolute', left: END, top: ROW.logTop }}
      />
    </motion.li>
  );
}

/** A spur off a station: 45° down from the mark, then along beside the line past its trains. */
function spurPoints(mark: number, minis: number): string {
  const end = miniAt(mark, Math.min(minis, MINIS) - 1) + 18;
  return `${mark},${ROW.line} ${mark + DROP},${ROW.spur} ${end},${ROW.spur}`;
}

/** A station: its sign, its mark on the line and its train, all one button for the inspector. */
function Station({
  station,
  projectName,
  left,
  slot,
  fresh,
}: {
  station: LineStation;
  projectName: string;
  left: number;
  slot: number;
  fresh: boolean;
}) {
  const { actor, minis } = station;
  const tip = useTip();
  const motion = trainMotion(actor.state);
  const status = boardStatus(actor);
  return (
    <>
      <div
        className={cx('transit-station-slot absolute', fresh && 'transit-pop')}
        style={{ left: left - 6, top: ROW.stationTop, width: slot - 12 }}
      >
        <ActorInspector
          projectId={actor.projectId}
          actorId={actor.id}
          label={`${projectName}, ${actor.label}`}
          trigger={
            <button
              type="button"
              tabIndex={-1}
              aria-label={actor.name}
              data-transit-item
              data-transit-station={actor.id}
              data-scene-actor={actor.id}
              data-actor-state={actor.state}
              data-actor-kind={actor.kind}
              data-train={motion}
              data-tone={actor.tone}
              {...tipHandlers(tip, actor.id, () => ({
                id: actor.id,
                title: actor.label,
                meta: `${actorKindName(actor.kind)} · ${status.word}`,
                detail: actor.caption.text,
              }))}
              className="transit-station"
            >
              <span className="transit-station-name" data-tone={status.tone}>
                {actor.label}
              </span>
              <span aria-hidden className="transit-mark" data-kind={actor.kind} />
              <TrainCar kind={actor.kind} motion={motion} />
            </button>
          }
        />
      </div>
      {minis.slice(0, MINIS).map((mini, i) => (
        <MiniTrain
          key={mini.id}
          actor={mini}
          projectName={projectName}
          left={miniAt(left + 8, i)}
        />
      ))}
      {minis.length > MINIS && (
        <span
          role="img"
          aria-label={`${minis.length - MINIS} more subagents`}
          className="transit-mini-more absolute font-mono text-meta text-text-2 tabular"
          style={{ left: miniAt(left + 8, MINIS - 1) + 24, top: ROW.spur - 8 }}
        >
          +{minis.length - MINIS}
        </span>
      )}
    </>
  );
}

/** A subagent or background task: a short train on its session's spur. */
function MiniTrain({
  actor,
  projectName,
  left,
}: {
  actor: SceneActor;
  projectName: string;
  left: number;
}) {
  const tip = useTip();
  const motion = trainMotion(actor.state);
  return (
    <div className="transit-mini-slot absolute" style={{ left: left - 12, top: ROW.spur - 12 }}>
      <ActorInspector
        projectId={actor.projectId}
        actorId={actor.id}
        label={`${projectName}, ${actor.label}`}
        trigger={
          <button
            type="button"
            tabIndex={-1}
            aria-label={actor.name}
            data-transit-item
            data-scene-actor={actor.id}
            data-actor-state={actor.state}
            data-actor-kind={actor.kind}
            data-train={motion}
            data-tone={actor.tone}
            {...tipHandlers(tip, actor.id, () => ({
              id: actor.id,
              title: actor.label,
              meta: actorKindName(actor.kind),
              detail: actor.caption.text,
            }))}
            className="transit-mini"
          >
            <TrainCar kind={actor.kind} motion={motion} mini />
          </button>
        }
      />
    </div>
  );
}
