import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useLocation } from 'wouter';
import { useOwnBackdrop } from '../ambient/backdrop.js';
import { useNow } from '../anim/clock.js';
import { OffstageContext } from '../anim/useFrame.js';
import { useBoard, useBoardStore } from '../data/index.js';
import { ActorInspector } from '../layouts/ActorInspector.js';
import { actorKindName, type SceneActor, type SceneProject } from '../layouts/scene.js';
import { SCENE_TICK_MS, useOverviewScene } from '../layouts/useScene.js';
import { dur, ease, useMotionLevel } from '../motion.js';
import { formatAgo, pulseTarget } from '../pulse/model.js';
import { projectHref } from '../routes.js';
import { toneLabel } from '../status.js';
import { terminalTarget } from '../terminal/target.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import {
  type Branch,
  branchPoints,
  buildBranches,
  buildStations,
  lineAcross,
  placeStops,
  placeTrains,
  point,
  type Station,
  type StationKind,
  type StationStop,
  stopTarget,
  TRAIN,
  type TrainSlot,
  type TransitFrame,
  ticks,
  trainMotion,
  transitFrame,
  VERTICAL_BELOW,
} from './map.js';

/** The desktop map's sticky column of line names. */
const LABEL_W = 176;

/** What the hover card is showing, placed over the stage (it never clips in the scroller). */
interface Tip {
  id: string;
  x: number;
  y: number;
  title: string;
  meta: string | null;
  detail: string | null;
}

/**
 * DESIGN.md §10.5: the board as a metro map. Each project is a line in its accent across the last
 * hour, notable events are its stations (merged into a count when crowded), subagent runs branch
 * off it, and every session and terminal is a train at the "now" end. The map scrolls through
 * time with "now" pinned at the right; on a phone the lines run top to bottom, now on top. The
 * map draws its own ground, so the ambient field steps out while it's shown.
 */
export default function TransitLayout() {
  useOwnBackdrop();
  const scene = useOverviewScene();
  const activity = useBoard((s) => s.activity);
  const now = useNow(SCENE_TICK_MS);
  const offstage = useContext(OffstageContext);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const vertical = width > 0 && width < VERTICAL_BELOW;
  const projects = scene.projects;
  const frame = useMemo(
    () => transitFrame(vertical ? 'vertical' : 'horizontal', projects.length, width),
    [vertical, projects.length, width],
  );
  const stations = useMemo(() => buildStations(activity, projects, now), [activity, projects, now]);
  const branches = useMemo(() => buildBranches(activity, projects, now), [activity, projects, now]);

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
        data-transit-axis={frame.axis}
        data-paused={offstage || undefined}
        className="transit relative w-full"
      >
        {width === 0 ? null : projects.length === 0 ? (
          <p className="py-16 text-center text-body-sm text-text-2">
            No lines yet. A project shows up here once it opens in your editor or Claude Code.
          </p>
        ) : (
          <TransitMap
            projects={projects}
            frame={frame}
            now={now}
            stations={stations}
            branches={branches}
          />
        )}
      </div>
    </>
  );
}

interface TransitMapProps {
  projects: readonly SceneProject[];
  frame: TransitFrame;
  now: number;
  stations: ReadonlyMap<string, Station[]>;
  branches: ReadonlyMap<string, Branch[]>;
}

function TransitMap({ projects, frame, now, stations, branches }: TransitMapProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const horizontal = frame.axis === 'horizontal';
  const offset = horizontal ? LABEL_W : 0;
  const width = horizontal ? LABEL_W + frame.length : frame.breadth;
  const height = horizontal ? frame.breadth : frame.length;

  // "Now" stays pinned at the right unless the reader scrolled back in time.
  const pinned = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin when the map's width changes.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !horizontal) return;
    if (pinned.current) element.scrollLeft = element.scrollWidth;
  }, [horizontal, width]);
  const onScroll = () => {
    const element = scroller.current;
    if (!element || !horizontal) return;
    pinned.current = element.scrollLeft + element.clientWidth >= element.scrollWidth - 4;
    setTip(null);
  };

  const showTip = (target: HTMLElement, next: Omit<Tip, 'x' | 'y'>) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return;
    const rect = target.getBoundingClientRect();
    setTip({ ...next, x: rect.left + rect.width / 2 - box.left, y: rect.top - box.top });
  };
  const hideTip = (id: string) => setTip((current) => (current?.id === id ? null : current));

  return (
    <div ref={stage} className="relative">
      <div
        ref={scroller}
        onScroll={onScroll}
        data-transit-scroller
        className="transit-scroller overflow-x-auto overflow-y-hidden"
      >
        <div
          data-transit-map
          className="relative"
          style={{ width, height, minWidth: horizontal ? undefined : '100%' }}
        >
          <TimeAxis frame={frame} now={now} offset={offset} width={width} height={height} />
          <ul aria-label="Lines" className="contents">
            {projects.map((project, index) => (
              <TransitLine
                key={project.id}
                project={project}
                index={index}
                frame={frame}
                now={now}
                stations={stations.get(project.id) ?? []}
                branches={branches.get(project.id) ?? []}
                showTip={showTip}
                hideTip={hideTip}
              />
            ))}
          </ul>
          {!horizontal && (
            // On the phone the labels cross the lines: drawn over them, haloed in the ground.
            <TimeAxis
              frame={frame}
              now={now}
              offset={offset}
              width={width}
              height={height}
              labels
            />
          )}
        </div>
      </div>
      {tip && (
        <div
          role="tooltip"
          data-transit-tip={tip.id}
          className="transit-tip pointer-events-none absolute z-20 w-max max-w-70 rounded-control border border-line bg-bg-2 px-3 py-1.5 text-label shadow-raised"
          style={{ left: tip.x, top: tip.y }}
        >
          <p className="flex items-baseline gap-2">
            <span className="font-medium text-text-1">{tip.title}</span>
            {tip.meta && <span className="tabular text-text-2">{tip.meta}</span>}
          </p>
          {tip.detail && (
            <p className="mt-0.5 line-clamp-2 break-words font-mono text-meta text-text-2">
              {tip.detail}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Ten-minute rules across the lines, their labels, and the "now" rule. */
function TimeAxis({
  frame,
  now,
  offset,
  width,
  height,
  labels = false,
}: {
  frame: TransitFrame;
  now: number;
  offset: number;
  width: number;
  height: number;
  /** Only the labels (the phone draws them over the lines); otherwise the rules and, on the
   * desktop, the labels in the row above the lines. */
  labels?: boolean;
}) {
  const horizontal = frame.axis === 'horizontal';
  const rules = [
    ...ticks(now, frame).map((t) => ({ ...t, now: false })),
    { minutes: 0, along: frame.nowAt, now: true },
  ];
  // The rules start under the names (phone) or the label row (desktop).
  const from = horizontal ? 32 : 0;
  return (
    <svg
      aria-hidden
      data-transit-axis-rules
      data-transit-axis-labels={labels || undefined}
      className="transit-axis pointer-events-none absolute top-0 left-0"
      style={labels ? { zIndex: 4 } : undefined}
      width={width}
      height={height}
    >
      {rules.map(({ minutes, along, now: isNow }) => {
        const at = offset + along;
        return (
          <g key={minutes} className={isNow ? 'transit-now' : undefined}>
            {horizontal ? (
              <>
                <line x1={at} x2={at} y1={from} y2={height} />
                <text x={at} y={20} textAnchor="middle">
                  {isNow ? 'now' : `−${minutes}m`}
                </text>
              </>
            ) : (
              <>
                {!labels && <line x1={0} x2={width} y1={at} y2={at} />}
                {labels && (
                  <text x={2} y={at - 4}>
                    {isNow ? 'now' : `−${minutes}m`}
                  </text>
                )}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

interface TransitLineProps {
  project: SceneProject;
  index: number;
  frame: TransitFrame;
  now: number;
  stations: readonly Station[];
  branches: readonly Branch[];
  showTip(target: HTMLElement, tip: Omit<Tip, 'x' | 'y'>): void;
  hideTip(id: string): void;
}

const KIND_WORD: Record<StationKind, string> = {
  turn: 'turn finished',
  ok: 'command exited ✓',
  fail: 'command failed ×',
  commit: 'commit',
  crash: 'crash',
};

function TransitLine({
  project,
  index,
  frame,
  now,
  stations,
  branches,
  showTip,
  hideTip,
}: TransitLineProps) {
  const horizontal = frame.axis === 'horizontal';
  const half = frame.lineGap / 2;
  const offset = horizontal ? LABEL_W : 0;
  // Section-local coordinates: the line runs through the middle of its band.
  const at = (along: number, across = 0) => point(along + offset, half + across, frame);
  const stops = useMemo(() => placeStops(stations, now, frame), [stations, now, frame]);
  const { trains, hidden, moreAt } = placeTrains(project.actors, frame);
  const lineEnd = horizontal ? frame.length - 24 : 56;
  const start = at(frame.startAt);
  const nowPoint = at(frame.nowAt);
  const end = at(lineEnd);
  const band = lineAcross(index, frame) - half;
  const accent = `var(--accent-${project.accent})`;

  const fresh = useFreshStops(stops);

  // The name is one Tab stop; arrows move through its trains and then its stations, newest
  // first, and Esc goes back to the name (§10.1).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const line = event.currentTarget;
    const name = line.querySelector<HTMLElement>('[data-transit-name]');
    if (event.key === 'Escape' && event.target !== name && !event.defaultPrevented) {
      event.preventDefault();
      name?.focus({ preventScroll: false });
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const items = [...line.querySelectorAll<HTMLElement>('[data-transit-item]')];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = current < 0 ? (step > 0 ? 0 : items.length - 1) : current + step;
    items[(next + items.length) % items.length]?.focus();
  };

  const counts = `${project.actors.length} ${project.actors.length === 1 ? 'train' : 'trains'}`;

  return (
    <li
      data-transit-line={project.id}
      data-tone={project.tone}
      data-dim={project.dim || undefined}
      data-scene-leaving={project.leaving}
      inert={project.leaving}
      onKeyDown={onKeyDown}
      className="transit-line absolute"
      style={
        {
          '--route': accent,
          ...(horizontal
            ? { left: 0, top: band, width: LABEL_W + frame.length, height: frame.lineGap }
            : { top: 0, left: band, width: frame.lineGap, height: frame.length }),
        } as CSSProperties
      }
    >
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-visible"
        width="100%"
        height="100%"
      >
        <line className="transit-track" x1={start.x} y1={start.y} x2={nowPoint.x} y2={nowPoint.y} />
        <line className="transit-platform" x1={nowPoint.x} y1={nowPoint.y} x2={end.x} y2={end.y} />
        {branches.map((branch) => (
          <polyline
            key={branch.id}
            data-transit-branch={branch.to === null ? 'open' : 'closed'}
            className="transit-branch"
            points={branchPoints(branch, now, frame)
              .map((p) => {
                const xy = at(p.along, p.across);
                return `${xy.x},${xy.y}`;
              })
              .join(' ')}
          />
        ))}
      </svg>

      <Link
        href={projectHref(project.id)}
        data-transit-name={project.id}
        aria-label={`${project.name} line, ${toneLabel(project.tone)}, ${counts}. Arrow keys move through its trains and stations.`}
        className={cx(
          'transit-name group flex min-w-0 items-center gap-2 outline-none',
          horizontal ? 'sticky left-0 h-full pr-4 pl-1' : 'h-14 flex-col justify-center px-0.5',
        )}
        style={horizontal ? { width: LABEL_W } : undefined}
      >
        <span aria-hidden className="transit-swatch shrink-0" />
        <span
          className={cx(
            'min-w-0 font-medium text-text-1',
            horizontal ? 'truncate text-body-sm' : 'transit-name-text max-w-full text-label',
          )}
          title={project.name}
        >
          {project.name}
        </span>
        <StatusDot
          tone={project.tone}
          label={toneLabel(project.tone)}
          className={horizontal ? 'ml-auto shrink-0' : 'shrink-0'}
        />
      </Link>

      {trains.map((train) => (
        <Train
          key={train.actor.id}
          train={train}
          xy={at(train.along)}
          vertical={!horizontal}
          projectName={project.name}
          showTip={showTip}
          hideTip={hideTip}
        />
      ))}
      {[...stops].reverse().map((stop) => (
        <StopButton
          key={stop.id}
          stop={stop}
          xy={at(stop.along)}
          fresh={fresh.has(stop.id)}
          now={now}
          showTip={showTip}
          hideTip={hideTip}
        />
      ))}

      {hidden > 0 && (
        <span
          role="img"
          aria-label={`${hidden} more in ${project.name}`}
          data-transit-more={hidden}
          className="transit-more font-mono text-meta text-text-2 tabular"
          style={{ transform: `translate(${at(moreAt).x}px, ${at(moreAt).y}px)` }}
        >
          +{hidden}
        </span>
      )}
    </li>
  );
}

/** Stops that arrived after the line was first drawn: they scale in once (§10.5). */
function useFreshStops(stops: readonly StationStop[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  if (seen.current === null) {
    seen.current = new Set(stops.map((s) => s.id));
  } else {
    for (const stop of stops) {
      if (!seen.current.has(stop.id)) {
        seen.current.add(stop.id);
        fresh.current.add(stop.id);
      }
    }
  }
  return fresh.current;
}

function stopLabel(stop: StationStop, now: number): string {
  const newest = stopTarget(stop);
  const ago = formatAgo(now - newest.ts);
  const what = `${newest.label}${newest.detail ? `: ${newest.detail}` : ''}, ${ago}`;
  if (stop.stations.length === 1) return what;
  return `${stop.stations.length} stops, the worst a ${KIND_WORD[stop.kind]}. Newest: ${what}`;
}

function StopButton({
  stop,
  xy,
  fresh,
  now,
  showTip,
  hideTip,
}: {
  stop: StationStop;
  xy: { x: number; y: number };
  fresh: boolean;
  now: number;
  showTip: TransitLineProps['showTip'];
  hideTip: TransitLineProps['hideTip'];
}) {
  const store = useBoardStore();
  const [, navigate] = useLocation();
  const target = stopTarget(stop);
  const count = stop.stations.length;

  const open = () => {
    const event = target.event;
    if (!event) {
      navigate(projectHref(target.projectId));
      return;
    }
    const where = pulseTarget(event, store.getState().board);
    if (!where) return;
    if (where.terminal) terminalTarget.set(where.terminal);
    navigate(where.href);
  };

  const tip = (element: HTMLElement) =>
    showTip(element, {
      id: stop.id,
      title: count > 1 ? `${count} stops` : target.label,
      meta: formatAgo(now - target.ts),
      detail:
        count > 1
          ? `Newest: ${target.label}${target.detail ? `, ${target.detail}` : ''}`
          : target.detail,
    });

  return (
    <button
      type="button"
      tabIndex={-1}
      data-transit-item
      data-transit-station={stop.id}
      data-kind={stop.kind}
      data-count={count}
      data-session={target.event?.sessionId ?? undefined}
      data-terminal={target.event?.terminalId ?? undefined}
      aria-label={stopLabel(stop, now)}
      onClick={open}
      onPointerEnter={(e: PointerEvent<HTMLButtonElement>) =>
        e.pointerType === 'mouse' && tip(e.currentTarget)
      }
      onPointerLeave={() => hideTip(stop.id)}
      onFocus={(e: FocusEvent<HTMLButtonElement>) => tip(e.currentTarget)}
      onBlur={() => hideTip(stop.id)}
      className="transit-stop absolute top-0 left-0"
      style={{ transform: `translate(${xy.x}px, ${xy.y}px)` }}
    >
      <span
        aria-hidden
        className={cx('transit-mark', fresh && 'transit-pop')}
        data-kind={stop.kind}
      >
        {count > 1 ? (
          <span className="font-mono tabular">{count}</span>
        ) : (
          <StationGlyph kind={stop.kind} />
        )}
      </span>
    </button>
  );
}

/** ✓ and × for exits and "!" for a crash, so the kind reads without color (§8). */
function StationGlyph({ kind }: { kind: StationKind }) {
  switch (kind) {
    case 'ok':
      return (
        <svg aria-hidden viewBox="-5 -5 10 10" className="transit-glyph">
          <path d="M-2.6 0.2 L-0.8 2 L2.6 -1.8" />
        </svg>
      );
    case 'fail':
      return (
        <svg aria-hidden viewBox="-5 -5 10 10" className="transit-glyph">
          <path d="M-2 -2 L2 2 M2 -2 L-2 2" />
        </svg>
      );
    case 'crash':
      return (
        <svg aria-hidden viewBox="-5 -5 10 10" className="transit-glyph">
          <path d="M0 -2.6 L0 0.6 M0 2.4 L0 2.6" />
        </svg>
      );
    default:
      return null;
  }
}

function Train({
  train,
  xy,
  vertical,
  projectName,
  showTip,
  hideTip,
}: {
  train: TrainSlot;
  xy: { x: number; y: number };
  vertical: boolean;
  projectName: string;
  showTip: TransitLineProps['showTip'];
  hideTip: TransitLineProps['hideTip'];
}) {
  const { actor, mini } = train;
  const level = useMotionLevel();
  const ref = useRef<HTMLDivElement>(null);
  const motion = trainMotion(actor.state);
  const len = mini ? TRAIN.miniLen : TRAIN.len;
  const thick = mini ? TRAIN.miniThick : TRAIN.thick;

  // Full glides to a new place in the queue (CSS); Reduced cross-fades into it instead.
  const last = useRef(xy);
  useEffect(() => {
    const moved = last.current.x !== xy.x || last.current.y !== xy.y;
    last.current = xy;
    if (!moved || level !== 'reduced') return;
    ref.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: dur.base * 1000,
      easing: `cubic-bezier(${ease.out.join(',')})`,
    });
  }, [xy, level]);

  const tip = (element: HTMLElement) =>
    showTip(element, {
      id: actor.id,
      title: actor.label,
      meta: actorKindName(actor.kind),
      detail: actor.caption.text,
    });

  return (
    <div
      ref={ref}
      className="transit-train-slot absolute top-0 left-0"
      style={{ transform: `translate(${xy.x}px, ${xy.y}px)` }}
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
            data-scene-actor={actor.id}
            data-actor-state={actor.state}
            data-actor-kind={actor.kind}
            data-train={motion}
            data-tone={actor.tone}
            onPointerEnter={(e) => e.pointerType === 'mouse' && tip(e.currentTarget)}
            onPointerLeave={() => hideTip(actor.id)}
            onFocus={(e) => tip(e.currentTarget)}
            onBlur={() => hideTip(actor.id)}
            className={cx('transit-train', vertical && 'is-vertical')}
          >
            <TrainBody kind={actor.kind} motion={motion} len={len} thick={thick} />
          </button>
        }
      />
    </div>
  );
}

/**
 * A rounded car facing the future: its windows take the state's tone, a working one trails speed
 * lines, a waiting one has amber doors that pulse, an errored one is rose with a "!" above it.
 * Claude trains carry a round headlight, terminals a square one.
 */
function TrainBody({
  kind,
  motion,
  len,
  thick,
}: {
  kind: SceneActor['kind'];
  motion: ReturnType<typeof trainMotion>;
  len: number;
  thick: number;
}) {
  const x = -len / 2;
  const y = -thick / 2;
  const windows = Math.max(1, Math.floor((len - 12) / 7));
  return (
    <svg
      aria-hidden
      className="transit-car overflow-visible"
      viewBox={`${x} ${y} ${len} ${thick}`}
      width={len}
      height={thick}
    >
      {motion === 'glide' && (
        <g className="transit-trail">
          <rect x={x - 22} y={-1.5} width={22} height={3} rx={1.5} className="transit-trail-glow" />
          <g className="transit-speed">
            {[0, 8, 16, 24].map((d) => (
              <line
                key={d}
                className="transit-speed-line"
                x1={x - 4 - d}
                x2={x - 8 - d}
                y1={y + 2}
                y2={y + 2}
              />
            ))}
            {[4, 12, 20].map((d) => (
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
      {Array.from({ length: windows }, (_, i) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed windows in a fixed car
          key={i}
          className="transit-window"
          x={x + 4 + i * 7}
          y={y + thick * 0.28}
          width={4.5}
          height={thick * 0.44}
          rx={1}
        />
      ))}
      {motion === 'wait' && (
        <g className="transit-doors">
          <rect x={-2.5} y={y + 1.5} width={2} height={thick - 3} />
          <rect x={0.5} y={y + 1.5} width={2} height={thick - 3} />
        </g>
      )}
      {kind === 'terminal' ? (
        <rect className="transit-light" x={-x - 5} y={-1.5} width={3} height={3} />
      ) : (
        <circle className="transit-light" cx={-x - 3.5} cy={0} r={1.75} />
      )}
      {motion === 'stop' && (
        <g className="transit-alert" transform={`translate(0 ${y - 7})`}>
          <circle r={5.5} />
          <path d="M0 -2.6 L0 0.8 M0 2.4 L0 2.6" />
        </g>
      )}
    </svg>
  );
}
