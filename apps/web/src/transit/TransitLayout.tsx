import { type RefObject, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useOwnBackdrop } from '../ambient/backdrop.js';
import { useNow } from '../anim/clock.js';
import { OffstageContext } from '../anim/useFrame.js';
import { useBoard } from '../data/index.js';
import { StatusLegend } from '../layouts/StatusLegend.js';
import type { SceneProject } from '../layouts/scene.js';
import { SCENE_TICK_MS, useOverviewScene } from '../layouts/useScene.js';
import { useMediaQuery } from '../prefs.js';
import { cx } from '../ui/cx.js';
import { DeparturesBoard } from './DeparturesBoard.js';
import {
  buildServiceLog,
  busiestLine,
  type ServiceEvent,
  TRANSIT_LEGEND,
  transitMode,
} from './map.js';
import { PhoneLine } from './PhoneLine.js';
import { TipCard, TipContext, useTipLayer } from './shared.js';
import { ROW, TransitLine } from './TransitLine.js';

/** Departures on the board, per layout; beside the map, as many as the window holds. */
const BOARD_ROWS = { wide: 16, stacked: 6, phone: 5 } as const;
/** A board row, and what the window spends above and below the board (HUD, title, Pulse bar). */
const BOARD_ROW_H = 49;
const BOARD_CHROME = 300;
const wideRows = (viewport: number) =>
  Math.max(6, Math.min(BOARD_ROWS.wide, Math.floor((viewport - BOARD_CHROME) / BOARD_ROW_H)));
/** The board's column beside the map. */
const BOARD_W = 360;
const GAP = 24;

/**
 * DESIGN.md §10.5: the board as a station concourse. A departures board lists every session and
 * terminal, what needs you on top; beside it (above it when narrow) the network map draws each
 * project as a line whose stations are its sessions and terminals, each with its train, and the
 * hour's service log under the line. On a phone the board comes first and each line reads top to
 * bottom as a station list. The concourse draws its own ground, so the ambient field steps out.
 */
export default function TransitLayout() {
  useOwnBackdrop();
  const scene = useOverviewScene();
  const activity = useBoard((s) => s.activity);
  const now = useNow(SCENE_TICK_MS);
  const offstage = useContext(OffstageContext);
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLUListElement>(null);
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      setWidth(Math.floor(element.clientWidth));
      setViewport(window.innerHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const projects = scene.projects;
  const mode = transitMode(width);
  // Touch screens get the station lists, whose rows and log bins are 44 px targets.
  const coarse = useMediaQuery('(pointer: coarse)');
  const lists = mode === 'phone' || coarse;
  const log = useMemo(() => buildServiceLog(activity, projects, now), [activity, projects, now]);
  const mapWidth = mode === 'wide' ? width - BOARD_W - GAP : width;

  const { api: tipApi, tip } = useTipLayer(ref);

  return (
    <>
      <div
        aria-hidden
        data-transit-ground
        className="transit-ground pointer-events-none fixed inset-0 -z-10"
      />
      <div
        ref={ref}
        data-transit
        data-transit-mode={width === 0 ? undefined : mode}
        data-paused={offstage || undefined}
        className="transit relative w-full"
      >
        {width === 0 ? null : projects.length === 0 ? (
          <p className="py-16 text-center text-body-sm text-text-2">
            No lines yet. A project shows up here once it opens in your editor or Claude Code.
          </p>
        ) : (
          <TipContext.Provider value={tipApi}>
            <StatusLegend lines={TRANSIT_LEGEND} />
            <div
              className={cx('transit-concourse', mode === 'wide' ? 'is-wide' : 'is-stacked')}
              style={
                mode === 'wide' ? { gridTemplateColumns: `${BOARD_W}px 1fr`, gap: GAP } : undefined
              }
            >
              <DeparturesBoard
                projects={projects}
                now={now}
                max={mode === 'wide' ? wideRows(viewport) : BOARD_ROWS[mode]}
                mapRef={mapRef}
                className={mode === 'wide' ? 'sticky top-4' : undefined}
              />
              <Network
                listRef={mapRef}
                projects={projects}
                lists={lists}
                width={mapWidth}
                now={now}
                log={log}
              />
            </div>
            {tip && <TipCard tip={tip} />}
          </TipContext.Provider>
        )}
      </div>
    </>
  );
}

const EMPTY: ServiceEvent[] = [];

/** The lines: desktop bands on one map, or phone station lists. */
function Network({
  listRef,
  projects,
  lists,
  width,
  now,
  log,
}: {
  listRef: RefObject<HTMLUListElement | null>;
  projects: readonly SceneProject[];
  lists: boolean;
  width: number;
  now: number;
  log: ReadonlyMap<string, ServiceEvent[]>;
}) {
  const order = projects.map((p) => p.id).join(' ');
  if (lists) {
    return (
      <ul
        ref={listRef}
        aria-label="Lines"
        data-transit-map
        className="transit-map flex flex-col gap-6"
      >
        {projects.map((project) => (
          <PhoneLine
            key={project.id}
            project={project}
            order={order}
            width={width}
            now={now}
            events={log.get(project.id) ?? EMPTY}
          />
        ))}
      </ul>
    );
  }
  const busiest = busiestLine(projects);
  return (
    <div data-transit-map className="transit-map min-w-0">
      <ul ref={listRef} aria-label="Lines" style={{ minHeight: projects.length * ROW.height }}>
        {projects.map((project) => (
          <TransitLine
            key={project.id}
            project={project}
            order={order}
            width={width}
            busiest={busiest}
            now={now}
            events={log.get(project.id) ?? EMPTY}
          />
        ))}
      </ul>
      {/* The service logs' time scale, under the last one. */}
      <div aria-hidden className="transit-axis" style={{ paddingInline: 6 }}>
        <span>−60m</span>
        <span className="mx-auto">service log, the last hour</span>
        <span>now</span>
      </div>
    </div>
  );
}
