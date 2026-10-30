import { motion } from 'motion/react';
import type { CSSProperties } from 'react';
import { Link } from 'wouter';
import { ActorInspector } from '../layouts/ActorInspector.js';
import type { SceneActor, SceneProject } from '../layouts/scene.js';
import { spring } from '../motion.js';
import { projectHref } from '../routes.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import {
  boardStatus,
  lineStations,
  PHONE_STATIONS,
  type ServiceEvent,
  TOUCH_BIN_PX,
  trainMotion,
} from './map.js';
import { ServiceLog } from './ServiceLog.js';
import { lineKeys, useFresh, useReturned } from './shared.js';
import { TrainCar } from './TrainCar.js';
import { LineSign, trainCount } from './TransitLine.js';

/**
 * DESIGN.md §10.5 on a phone: a line as the diagram on a station wall, read top to bottom. The
 * sign heads it, the hour's service log runs under it, then the line drops down the left edge
 * through one station per session and terminal (a 52 px row: mark, train, name, status), with
 * subagents on a 45° spur.
 */
export function PhoneLine({
  project,
  order,
  width,
  now,
  events,
}: {
  project: SceneProject;
  /** The lines' order: a change glides each line to its new place (§3 rule 3). */
  order: string;
  width: number;
  now: number;
  events: readonly ServiceEvent[];
}) {
  const { stations, hidden } = lineStations(project.actors, PHONE_STATIONS);
  const fresh = useFresh(stations.map((s) => s.actor.id));
  const counts = trainCount(project.actors);
  const returned = useReturned(project.id);
  return (
    <motion.li
      layout="position"
      layoutDependency={order}
      transition={{ layout: spring.smooth }}
      data-transit-line={project.id}
      data-tone={project.tone}
      data-dim={project.dim || undefined}
      data-returned={returned || undefined}
      data-scene-leaving={project.leaving}
      inert={project.leaving}
      onKeyDown={lineKeys}
      className="transit-line transit-phone-line"
      style={{ '--route': `var(--accent-${project.accent})` } as CSSProperties}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <LineSign project={project} counts={counts} className="min-h-11" />
        <span className="shrink-0 text-meta text-text-3 tabular">{counts}</span>
      </div>
      <ServiceLog events={events} now={now} width={width} binPx={TOUCH_BIN_PX} height={44} />
      <ul aria-label={`${project.name} stations`} className="transit-phone-stations">
        {stations.flatMap(({ actor, minis }) => [
          <PhoneStation
            key={actor.id}
            actor={actor}
            projectName={project.name}
            fresh={fresh.has(actor.id)}
          />,
          ...minis.map((mini) => (
            <PhoneStation
              key={mini.id}
              actor={mini}
              projectName={project.name}
              fresh={false}
              mini
            />
          )),
        ])}
        {hidden > 0 && (
          <li className="transit-phone-station">
            <Link
              href={projectHref(project.id)}
              tabIndex={-1}
              data-transit-item
              data-transit-more={hidden}
              className="transit-phone-row text-body-sm text-text-2"
            >
              <span aria-hidden className="transit-mark" data-kind="more" />
              <span>
                +{hidden} more in {project.name}
              </span>
            </Link>
          </li>
        )}
      </ul>
    </motion.li>
  );
}

function PhoneStation({
  actor,
  projectName,
  fresh,
  mini = false,
}: {
  actor: SceneActor;
  projectName: string;
  fresh: boolean;
  mini?: boolean;
}) {
  const motion = trainMotion(actor.state);
  const status = boardStatus(actor);
  return (
    <li
      className={cx('transit-phone-station', fresh && 'transit-pop')}
      data-mini={mini || undefined}
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
            data-transit-station={mini ? undefined : actor.id}
            data-scene-actor={actor.id}
            data-actor-state={actor.state}
            data-actor-kind={actor.kind}
            data-train={motion}
            data-tone={actor.tone}
            className="transit-phone-row"
          >
            <span aria-hidden className="transit-mark" data-kind={mini ? 'mini' : actor.kind} />
            <TrainCar kind={actor.kind} motion={motion} mini={mini} className="is-phone" />
            <span className="min-w-0 flex-1 truncate text-body-sm font-semibold text-text-1">
              {actor.label}
            </span>
            <span className="transit-board-status shrink-0" data-tone={status.tone}>
              {status.tone !== 'idle' && <StatusDot tone={status.tone} label={status.word} />}
              {status.word}
            </span>
          </button>
        }
      />
    </li>
  );
}
