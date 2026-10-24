import type { KeyboardEvent, RefObject } from 'react';
import { ActorInspector } from '../layouts/ActorInspector.js';
import type { SceneProject } from '../layouts/scene.js';
import { cx } from '../ui/cx.js';
import { type BoardRow, boardRows } from './map.js';
import { Roundel } from './TransitLine.js';

const clock = (now: number) =>
  new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * The concourse's departures board (DESIGN.md §10.5): every session and terminal as a departure,
 * the ones that need you on top ("Due · needs you" in amber, "Cancelled" in rose), then work
 * ("Departing"), then the rest. A row opens the Actor inspector; pointing at one lights its
 * station on the map. The board is one Tab stop, the arrows move between its rows.
 */
export function DeparturesBoard({
  projects,
  now,
  max,
  mapRef,
  className,
}: {
  projects: readonly SceneProject[];
  now: number;
  max: number;
  /** The map whose station a row lights up while pointed at. */
  mapRef: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const { rows, hidden, due, departing } = boardRows(projects, max);
  const light = (id: string, on: boolean) => {
    const station = mapRef.current?.querySelector(`[data-transit-station="${CSS.escape(id)}"]`);
    station?.toggleAttribute('data-lit', on);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    const edge = { Home: 'first', End: 'last' }[event.key];
    if (!step && !edge) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-board-row]')];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      edge === 'first'
        ? 0
        : edge === 'last'
          ? items.length - 1
          : Math.max(0, Math.min(items.length - 1, current + (step ?? 0)));
    for (const [i, item] of items.entries()) item.tabIndex = i === next ? 0 : -1;
    items[next]?.focus();
  };
  const summary = [due > 0 && `${due} due`, departing > 0 && `${departing} departing`]
    .filter(Boolean)
    .join(' · ');

  return (
    <section data-transit-board aria-label="Departures" className={cx('transit-board', className)}>
      <header className="flex items-baseline gap-3 px-4 pt-3.5 pb-2.5">
        <h2 className="transit-board-title">Departures</h2>
        <span className="min-w-0 flex-1 truncate text-meta text-text-2 tabular">{summary}</span>
        <time
          className="font-mono text-label text-text-1 tabular"
          dateTime={new Date(now).toISOString()}
        >
          {clock(now)}
        </time>
      </header>
      {rows.length === 0 ? (
        <p className="border-t border-white/6 px-4 py-4 text-body-sm text-text-2">
          No trains running. Sessions and terminals board here as they start.
        </p>
      ) : (
        <ul aria-label="Departures" className="transit-board-rows" onKeyDown={onKeyDown}>
          {rows.map((row, i) => (
            <Row key={row.actor.id} row={row} first={i === 0} light={light} />
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p
          data-board-more={hidden}
          className="border-t border-white/6 px-4 py-2.5 text-meta text-text-2 tabular"
        >
          +{hidden} more on the lines
        </p>
      )}
    </section>
  );
}

function Row({
  row,
  first,
  light,
}: {
  row: BoardRow;
  first: boolean;
  light(id: string, on: boolean): void;
}) {
  const { actor, project, status } = row;
  return (
    <li className="transit-board-item">
      <ActorInspector
        projectId={actor.projectId}
        actorId={actor.id}
        label={`${project.name}, ${actor.label}`}
        trigger={
          <button
            type="button"
            tabIndex={first ? 0 : -1}
            data-board-row={actor.id}
            data-tone={status.tone}
            aria-label={`${actor.name}. ${status.word}.`}
            onPointerEnter={() => light(actor.id, true)}
            onPointerLeave={() => light(actor.id, false)}
            onFocus={() => light(actor.id, true)}
            onBlur={() => light(actor.id, false)}
            className="transit-board-row"
          >
            <Roundel project={project} size={22} />
            <span className="min-w-0">
              <span className="block truncate text-body-sm font-semibold text-text-1">
                {actor.label}
              </span>
              <span className="block truncate font-mono text-meta text-text-2">
                {project.name}
                {actor.caption.text ? ` · ${actor.caption.text}` : ''}
              </span>
            </span>
            <span key={status.word} className="transit-board-status" data-tone={status.tone}>
              {status.word}
            </span>
          </button>
        }
      />
    </li>
  );
}
