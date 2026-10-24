import './transit-skin.css';
import { ArrowLeft, GitBranch } from 'lucide-react';
import { animate } from 'motion/react';
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useLocation } from 'wouter';
import { useNow } from '../../../anim/clock.js';
import { useBoard } from '../../../data/index.js';
import { actorId, type SceneActor } from '../../../layouts/scene.js';
import { SCENE_TICK_MS, useSceneProject } from '../../../layouts/useScene.js';
import { dur, ease, spring } from '../../../motion.js';
import { useMediaQuery } from '../../../prefs.js';
import { routes } from '../../../routes.js';
import { terminalTarget } from '../../../terminal/target.js';
import {
  buildServiceLog,
  busiestLine,
  lineStations,
  type ServiceEvent,
  TOUCH_BIN_PX,
} from '../../../transit/map.js';
import { lineKeys, lineReturn, TipCard, TipContext, useTipLayer } from '../../../transit/shared.js';
import { LineBody, ROW, Roundel, trainCount } from '../../../transit/TransitLine.js';
import { buttonClass } from '../../../ui/Button.js';
import { cx } from '../../../ui/cx.js';
import { StatusDot } from '../../../ui/StatusDot.js';
import { Tooltip } from '../../../ui/Tooltip.js';
import { FocusCaption } from '../../FocusCaption.js';
import type {
  EntryTransitionProps,
  HeaderBandProps,
  HubCrewProps,
  PanelFrameProps,
  WorkspaceSkin,
} from '../types.js';
import { boardWord } from './words.js';

/**
 * The band draws the map's line without its sign row (the band's own sign stands beside it), so
 * the line's geometry (`ROW`) moves up by this much.
 */
const SIGN_ROW = ROW.stationTop - 2;
const EMPTY: ServiceEvent[] = [];
/** Stations on the phone hub's little line. */
const HUB_STATIONS = 4;

/** What a station in the band selects: a terminal's tab, or a session (a subagent's own). */
function selectActor(actor: SceneActor, navigate: (href: string) => void) {
  if (actor.kind === 'terminal') {
    if (actor.links.terminalId) {
      terminalTarget.set({ projectId: actor.projectId, terminalId: actor.links.terminalId });
    }
    return;
  }
  if (actor.links.sessionId) navigate(actor.links.href);
}

/**
 * Transit's header band (DESIGN.md §10.8): the project's own line from the map. Its sign (roundel,
 * name, branch, the "Needs you" or "Failed" flag) heads the band; beside it the line runs with its
 * stations and trains, the subagent spurs and the hour's service log, drawn by the map's own
 * renderer. A station selects its session or terminal; a log bin jumps to its event, as on the
 * Pulse rail. The line is one Tab stop (its first station), the arrows move along it.
 */
function TransitHeaderBand({ project, session, headingRef }: HeaderBandProps) {
  const scene = useSceneProject(project.id);
  const activity = useBoard((s) => s.activity);
  const now = useNow(SCENE_TICK_MS);
  const events = useMemo(
    () => (scene ? (buildServiceLog(activity, [scene], now).get(scene.id) ?? EMPTY) : EMPTY),
    [activity, scene, now],
  );
  const bandRef = useRef<HTMLElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const width = useWidth(lineRef);
  const { api, tip } = useTipLayer(bandRef, 'below');
  const [, navigate] = useLocation();
  // Touch gets the map's touch bins (§10.5: 44 px apart); the CSS grows their hit areas to match.
  const coarse = useMediaQuery('(pointer: coarse)');
  // Back on the map, the line the workspace came from lights up for a moment.
  useEffect(() => () => lineReturn.mark(project.id), [project.id]);

  const tone = scene?.tone ?? 'idle';
  const flagged = tone === 'wait' || tone === 'err';
  const branch = project.git?.branch ?? null;
  const live = session !== null && session.status.kind !== 'ended';
  const counts = scene ? trainCount(scene.actors) : null;
  return (
    <header
      ref={bandRef}
      data-transit-band={project.id}
      data-tone={tone}
      className="ts-band"
      style={{ '--route': `var(--accent-${project.accent})` } as CSSProperties}
    >
      <Tooltip content="Back to the overview" shortcut="Esc">
        <Link
          href={routes.overview}
          aria-label="Back to the overview"
          className={cx(buttonClass('ghost', 'sm', { square: true }), 'shrink-0')}
        >
          <ArrowLeft className="size-4" strokeWidth={1.5} />
        </Link>
      </Tooltip>
      <div data-transit-band-sign className="ts-band-sign">
        <Roundel project={project} size={36} />
        <div className="flex min-w-0 flex-col gap-1">
          <h1
            ref={headingRef}
            tabIndex={-1}
            title={project.name}
            className="ts-band-name truncate outline-none focus-visible:shadow-none"
          >
            {project.name}
          </h1>
          <p className="flex min-w-0 items-center gap-2 text-meta text-text-2">
            {branch ? (
              <span className="flex min-w-0 items-center gap-1 font-mono" title={branch}>
                <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{branch}</span>
              </span>
            ) : (
              <span className="truncate font-mono" title={project.path}>
                {project.path}
              </span>
            )}
            {flagged ? (
              <span className="transit-flag shrink-0" data-tone={tone}>
                <StatusDot tone={tone} label={tone === 'wait' ? 'Needs you' : 'Failed'} />
                {tone === 'wait' ? 'Needs you' : 'Failed'}
              </span>
            ) : (
              counts && <span className="shrink-0 text-text-3 tabular">{counts}</span>
            )}
          </p>
        </div>
      </div>
      <TipContext.Provider value={api}>
        {/* biome-ignore lint/a11y/useSemanticElements: a line of stations, not a form's fieldset */}
        <div
          ref={lineRef}
          role="group"
          aria-label={`${project.name} line. Arrow keys move through its stations and service log.`}
          data-band-line
          onKeyDown={lineKeys}
          className="ts-band-line"
        >
          {scene && width > 0 && (
            <div className="ts-band-track" style={{ top: -SIGN_ROW, height: ROW.height }}>
              <LineBody
                project={scene}
                width={width}
                busiest={busiestLine([scene])}
                now={now}
                events={events}
                select={(actor) => selectActor(actor, navigate)}
                selected={session ? actorId.session(session.id) : null}
                binPx={coarse ? TOUCH_BIN_PX : undefined}
              />
            </div>
          )}
        </div>
      </TipContext.Provider>
      {session && live && (
        <div className="ts-band-caption hidden min-w-0 xl:block">
          <FocusCaption session={session} />
        </div>
      )}
      {tip && <TipCard tip={tip} placement="below" />}
    </header>
  );
}

/** An element's width, measured on resize only. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * A flat signage panel (§10.8): no glass, a hairline, and a strip in the line's color along the
 * top, amber or rose when the panel waits or failed.
 */
function TransitPanelFrame({ title, tone, children }: PanelFrameProps) {
  return (
    <div className="ts-panel" data-transit-panel={title} data-tone={tone}>
      <div className="ts-panel-body">{children}</div>
    </div>
  );
}

/**
 * The map, continued (§10.8): the project's line grows from its place on the map into the header
 * band while the panels rise in, on `smooth`. The line is a still copy for the move (the live one
 * stays on the map under the card). Full only; Reduced cross-fades and Off cuts.
 */
function TransitEntry({ projectId }: EntryTransitionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(false);

  useLayoutEffect(() => {
    const overlay = ref.current;
    const card = overlay?.parentElement;
    if (!overlay || !card) return;
    const id = CSS.escape(projectId);
    const source = document.querySelector<HTMLElement>(`main [data-transit-line="${id}"]`);
    const band = card.querySelector<HTMLElement>('[data-transit-band]');
    const line = band?.querySelector<HTMLElement>('[data-band-line]');
    const panels = [...card.querySelectorAll<HTMLElement>('.ts-panel')];
    const runs: { stop(): void }[] = [];

    for (const panel of panels) {
      runs.push(animate(panel, { opacity: [0, 1], y: [16, 0] }, { ...spring.smooth, delay: 0.08 }));
    }
    let ghost: HTMLElement | null = null;
    const from = source?.getBoundingClientRect();
    if (source && band && line && from && from.width > 0 && onScreen(from)) {
      const to = line.getBoundingClientRect();
      const at = card.getBoundingClientRect();
      const w = source.offsetWidth;
      const h = source.offsetHeight;
      ghost = stillCopy(source);
      Object.assign(ghost.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: `${w}px`,
        height: `${h}px`,
        transformOrigin: '0 0',
      });
      overlay.append(ghost);
      // The map's track lands on the band's: same left edge, same track height.
      const scale = to.width / w;
      runs.push(
        animate(
          ghost,
          {
            x: [from.left - at.left, to.left - at.left],
            y: [from.top - at.top, to.top - at.top - SIGN_ROW * scale],
            scale: [from.width / w, scale],
          },
          spring.smooth,
        ),
        animate(
          ghost,
          { opacity: [1, 1, 0] },
          { duration: dur.slow, ease: ease.out, times: [0, 0.55, 1] },
        ),
        animate(band, { opacity: [0, 1] }, { duration: dur.base, ease: ease.out, delay: dur.fast }),
      );
    }
    const finish = () => {
      for (const panel of panels) panel.style.transform = '';
      setDone(true);
    };
    Promise.all(runs).then(finish, finish);
    return () => {
      for (const run of runs) run.stop();
      for (const panel of panels) {
        panel.style.transform = '';
        panel.style.opacity = '';
      }
      if (band) band.style.opacity = '';
      ghost?.remove();
    };
  }, [projectId]);

  if (done) return null;
  return <div ref={ref} aria-hidden inert data-transit-entry className="ts-entry" />;
}

const onScreen = (rect: DOMRect) => rect.bottom > 0 && rect.top < window.innerHeight;

/** A still copy of the line for the entry: no ids, hooks or controls a test or reader could find. */
function stillCopy(line: HTMLElement): HTMLElement {
  const copy = line.cloneNode(true) as HTMLElement;
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
    el.removeAttribute('id');
    el.removeAttribute('tabindex');
    for (const name of el.getAttributeNames()) {
      if (/^data-(scene|transit|focus|board)/.test(name)) el.removeAttribute(name);
    }
  }
  copy.dataset.transitGhost = '';
  return copy;
}

/**
 * The phone hub's app bar carries the project's line (§10.8 "Phones"): a short track with a mark
 * per station (up to 4), ringed amber or rose when one waits or failed. Decoration; the board of
 * cards below is the way in.
 */
function TransitHubLine({ projectId }: HubCrewProps) {
  const scene = useSceneProject(projectId);
  if (!scene) return null;
  const { stations } = lineStations(scene.actors, HUB_STATIONS);
  if (stations.length === 0) return null;
  return (
    <span
      aria-hidden
      data-transit-hub-line
      className="ts-hub-line"
      style={{ '--route': `var(--accent-${scene.accent})` } as CSSProperties}
    >
      {stations.map(({ actor }) => (
        <span key={actor.id} data-actor-state={actor.state} className="ts-hub-stop">
          <span className="transit-mark" data-kind={actor.kind} />
        </span>
      ))}
    </span>
  );
}

const transitSkin: WorkspaceSkin = {
  HeaderBand: TransitHeaderBand,
  PanelFrame: TransitPanelFrame,
  EntryTransition: TransitEntry,
  HubCrew: TransitHubLine,
  statusWord: boardWord,
};

export default transitSkin;
