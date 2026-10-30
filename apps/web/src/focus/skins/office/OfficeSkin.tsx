import './office-skin.css';
import type { Project } from '@yardmaster/protocol';
import { ArrowLeft, GitBranch } from 'lucide-react';
import { animate } from 'motion/react';
import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useMaxActivityStep } from '../../../data/index.js';
import type { SceneActor, SceneProject } from '../../../layouts/scene.js';
import { useSceneProject } from '../../../layouts/useScene.js';
import { dur, ease, spring } from '../../../motion.js';
import { useKitLive } from '../../../office/kit/loops.js';
import { Whiteboard } from '../../../office/kit/Whiteboard.js';
import { ActorMascot } from '../../../office/OfficeCharacter.js';
import { routes } from '../../../routes.js';
import { ProjectAvatar } from '../../../shell/ProjectAvatar.js';
import { terminalTarget } from '../../../terminal/target.js';
import { buttonClass } from '../../../ui/Button.js';
import { cx } from '../../../ui/cx.js';
import { Tooltip } from '../../../ui/Tooltip.js';
import { FocusCaption, FocusStatus } from '../../FocusCaption.js';
import type {
  EntryTransitionProps,
  HeaderBandProps,
  HubCrewProps,
  PanelFrameProps,
  WorkspaceSkin,
} from '../types.js';
import { BAND_CREW, bandCrew, bandSelection, HUB_CREW } from './band.js';

/** Band characters: small, as the spec asks, still big enough to act their state (§4.11). */
const BAND_CREW_PX = 48;
const HUB_CREW_PX = 32;

type DoorLight = 'off' | 'wait' | 'err';
const doorLight = (scene: SceneProject | null): DoorLight =>
  scene?.tone === 'wait' ? 'wait' : scene?.tone === 'err' ? 'err' : 'off';

/** The ceiling light's strength, as the room's (kit/RoomShell). */
function lampStrength(scene: SceneProject | null): number {
  if (!scene) return 0.14;
  if (scene.dim) return 0.06;
  const light = Math.max(scene.activity, ...scene.actors.map((a) => a.activity));
  return 0.14 + 0.5 * Math.min(1, Math.max(0, light));
}

/** The main session (the oldest) wears the project's accent, as in the room. */
const mainSession = (scene: SceneProject | null) =>
  scene?.actors.filter((a) => a.kind === 'claude').sort((a, b) => a.since - b.since)[0]?.id;

/**
 * Office's header band (DESIGN.md §10.8): the room's front. The door in the project's accent with
 * its light, the nameplate (the project's name, branch and dirty count), the whiteboard's todo
 * lines, the ceiling light following the room's activity, and the room's characters at small size
 * acting their live states. A click on a character selects its session or terminal, like its row
 * in the session list or its tab.
 */
function OfficeHeaderBand({ project, session, headingRef }: HeaderBandProps) {
  const scene = useSceneProject(project.id);
  const ref = useRef<HTMLElement>(null);
  const live = useKitLive(ref);
  const light = doorLight(scene);
  const lamp = lampStrength(scene);
  const crewRef = useRef<HTMLDivElement>(null);
  const seats = useSeats(crewRef);
  const crew = bandCrew(scene?.actors ?? [], seats);
  const main = mainSession(scene);
  const board = scene && (scene.todos.length > 0 || scene.summary);
  return (
    <header
      ref={ref}
      data-office-band
      data-kit="room"
      data-kit-door={light}
      data-kit-paused={live ? undefined : ''}
      className="os-band kit"
      style={{ '--room-accent': `var(--accent-${project.accent})` } as CSSProperties}
    >
      <Tooltip content="Back to the overview" shortcut="Esc">
        <Link
          href={routes.overview}
          aria-label="Back to the overview"
          className={cx(buttonClass('ghost', 'sm', { square: true }), 'os-band-back')}
        >
          <ArrowLeft className="size-4" strokeWidth={1.5} />
        </Link>
      </Tooltip>
      <Door light={light} />
      <Nameplate project={project} scene={scene} headingRef={headingRef} />
      {board && (
        <div data-office-whiteboard className="os-band-board hidden xl:block">
          <Whiteboard items={scene.todos} summary={scene.summary} />
        </div>
      )}
      <div ref={crewRef} className="os-band-crew">
        <span
          aria-hidden
          data-office-lamp={lamp.toFixed(2)}
          className="kit-lamp os-band-lamp"
          style={{ opacity: lamp }}
        />
        <span aria-hidden className="os-band-shade" />
        <ul aria-label={`In ${project.name}`} className="os-band-row">
          {crew.shown.map((actor) => (
            <li key={actor.id}>
              <BandCharacter
                actor={actor}
                size={BAND_CREW_PX}
                color={actor.id === main ? 'var(--room-accent)' : undefined}
                selected={session !== null && actor.links.sessionId === session.id}
              />
            </li>
          ))}
        </ul>
        {crew.hidden > 0 && (
          <span
            role="img"
            aria-label={`${crew.hidden} more in ${project.name}`}
            data-band-more={crew.hidden}
            className="os-band-more tabular"
          >
            +{crew.hidden}
          </span>
        )}
      </div>
      {session && session.status.kind !== 'ended' && (
        <div className="hidden min-w-0 max-w-[26rem] flex-1 basis-0 items-center gap-3 xl:flex">
          <FocusStatus session={session} />
          <div className="min-w-0 flex-1">
            <FocusCaption session={session} />
          </div>
        </div>
      )}
    </header>
  );
}

/** A seat in the band's row: a character and the gap after it. The "+N" keeps its own room. */
const SEAT_PX = BAND_CREW_PX + 2;
const MORE_PX = 44;

/**
 * How many characters fit the crew's corner (up to `BAND_CREW`), so a narrow band seats fewer
 * whole characters instead of cutting one in half. Measured on resize only.
 */
function useSeats(ref: RefObject<HTMLElement | null>): number {
  const [seats, setSeats] = useState(BAND_CREW);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const all = Math.floor(width / SEAT_PX);
      setSeats(all >= BAND_CREW ? BAND_CREW : Math.max(1, Math.floor((width - MORE_PX) / SEAT_PX)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return seats;
}

/** The door on the band's left wall, in the project's accent, with the door light above. */
function Door({ light }: { light: DoorLight }) {
  return (
    <span aria-hidden className="os-band-door">
      <span
        data-kit-door-light={light}
        className={cx('kit-door-light os-band-door-light', light !== 'off' && 'kit-anim')}
      />
      <svg aria-hidden viewBox="0 0 28 54" className="os-band-door-svg">
        <rect x="0.5" y="0.5" width="27" height="53" rx="2" className="kit-door" />
        <rect x="4" y="5" width="20" height="21" rx="1.5" className="kit-line-strong" fill="none" />
        <rect
          x="4"
          y="29"
          width="20"
          height="20"
          rx="1.5"
          className="kit-line-strong"
          fill="none"
        />
        <circle cx="22" cy="28" r="1.6" fill="var(--room-accent)" />
      </svg>
    </span>
  );
}

function Nameplate({
  project,
  scene,
  headingRef,
}: {
  project: Project;
  scene: SceneProject | null;
  headingRef: HeaderBandProps['headingRef'];
}) {
  const branch = project.git?.branch ?? null;
  const dirty = scene?.dirty ?? 0;
  return (
    <div data-kit-nameplate className="os-band-plate">
      <ProjectAvatar project={project} size="lg" />
      <div className="flex min-w-0 flex-col">
        <h1
          ref={headingRef}
          tabIndex={-1}
          title={project.name}
          className="truncate font-medium text-title text-text-1 outline-none focus-visible:shadow-none"
        >
          {project.name}
        </h1>
        <p className="flex min-w-0 items-center gap-2 font-mono text-meta text-text-2">
          {branch ? (
            <span className="flex min-w-0 items-center gap-1" title={branch}>
              <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
              <span className="truncate">{branch}</span>
              {dirty > 0 && (
                <span className="shrink-0 text-st-wait-ink tabular" title={`${dirty} changed`}>
                  ●{dirty}
                </span>
              )}
            </span>
          ) : (
            <span className="truncate" title={project.path}>
              {project.path}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * One of the room's characters in the band, acting its live state. Its name tag (label and live
 * caption) is the tooltip; a click selects what it is.
 */
function BandCharacter({
  actor,
  size,
  color,
  selected,
}: {
  actor: SceneActor;
  size: number;
  color?: string;
  selected: boolean;
}) {
  const [, navigate] = useLocation();
  const target = bandSelection(actor);
  const select = () => {
    if (!target) return;
    if (target.kind === 'session') navigate(target.href);
    else terminalTarget.set({ projectId: actor.projectId, terminalId: target.terminalId });
  };
  return (
    <Tooltip content={`${actor.label} · ${actor.caption.text}`}>
      <button
        type="button"
        aria-label={actor.name}
        aria-current={selected || undefined}
        data-band-actor={actor.id}
        data-actor-state={actor.state}
        onClick={select}
        className="os-band-actor"
        style={{ width: Math.max(44, size), height: size + 4 }}
      >
        <span className="relative block" style={{ width: size, height: size }}>
          <ActorMascot actor={actor} size={size} color={color} drawing={false} />
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * The phone hub's nameplate crew (§10.8 "Phones"): up to 3 of the room's characters beside the
 * project's name, acting their states. Decoration; the hub's cards below are the way in.
 */
function OfficeHubCrew({ projectId }: HubCrewProps) {
  const scene = useSceneProject(projectId);
  const crew = bandCrew(scene?.actors ?? [], HUB_CREW);
  const main = mainSession(scene);
  if (crew.shown.length === 0) return null;
  return (
    <span aria-hidden data-office-hub-crew className="os-hub-crew">
      {crew.shown.map((actor) => (
        <span
          key={actor.id}
          className="relative block"
          style={{ width: HUB_CREW_PX, height: HUB_CREW_PX }}
        >
          <ActorMascot
            actor={actor}
            size={HUB_CREW_PX}
            color={actor.id === main ? `var(--accent-${scene?.accent})` : undefined}
            drawing={false}
          />
        </span>
      ))}
    </span>
  );
}

/** The power LED's color: the panel's status, else working while busy, else on and idle. */
function ledFor(tone: PanelFrameProps['tone'], step: number): string {
  if (tone === 'wait' || tone === 'err') return tone;
  return step > 0 ? 'work' : 'on';
}

/**
 * A monitor on a desk (§10.8): a thin bezel with a 1 px line, the panel as its screen, and a chin
 * with the panel's name and a power LED in its status color. The Claude monitor has the desk
 * lamp's warm glow under it in Night.
 */
function OfficePanelFrame({ title, activity, tone, children }: PanelFrameProps) {
  const step = useMaxActivityStep(activity);
  return (
    <div className="os-monitor" data-office-panel={title} data-led={ledFor(tone, step)}>
      {title === 'Claude' && <span aria-hidden className="os-desk-lamp" />}
      <div className="os-screen">{children}</div>
      <div aria-hidden className="os-chin">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span data-office-led className="os-led" />
      </div>
    </div>
  );
}

/**
 * The room view, continued (§10.8): the zoomed room's front shrinks into the header band while
 * the monitors rise in, on `smooth`. The room is a still copy for the move (the live one stays in
 * the building under the card). Full only; Reduced cross-fades and Off cuts.
 */
function OfficeEntry({ projectId }: EntryTransitionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(false);

  useLayoutEffect(() => {
    const overlay = ref.current;
    const card = overlay?.parentElement;
    if (!overlay || !card) return;
    const id = CSS.escape(projectId);
    const room =
      document.querySelector<HTMLElement>(`[data-room-entered][data-room="${id}"] [data-kit]`) ??
      document.querySelector<HTMLElement>(`[data-room="${id}"] [data-kit]`);
    const band = card.querySelector<HTMLElement>('[data-office-band]');
    const monitors = [...card.querySelectorAll<HTMLElement>('.os-monitor')];
    const runs: { stop(): void }[] = [];

    for (const monitor of monitors) {
      runs.push(
        animate(monitor, { opacity: [0, 1], y: [24, 0] }, { ...spring.smooth, delay: 0.08 }),
      );
    }
    let ghost: HTMLElement | null = null;
    if (room && band) {
      const from = room.getBoundingClientRect();
      const to = band.getBoundingClientRect();
      const at = card.getBoundingClientRect();
      const w = room.offsetWidth;
      const h = room.offsetHeight;
      if (from.width > 0 && w > 0 && h > 0) {
        ghost = stillCopy(room);
        Object.assign(ghost.style, {
          position: 'absolute',
          left: '0',
          top: '0',
          width: `${w}px`,
          height: `${h}px`,
          transformOrigin: '0 0',
        });
        overlay.append(ghost);
        // The room's door (14 units in) lands on the band's door.
        const door = band.querySelector<HTMLElement>('.os-band-door')?.getBoundingClientRect();
        const scale = to.height / h;
        const endX = (door ? door.left : to.left) - at.left - 14 * scale;
        runs.push(
          animate(
            ghost,
            {
              x: [from.left - at.left, endX],
              y: [from.top - at.top, to.top - at.top],
              scale: [from.width / w, scale],
            },
            spring.smooth,
          ),
          animate(
            ghost,
            { opacity: [1, 1, 0] },
            { duration: dur.slow, ease: ease.out, times: [0, 0.55, 1] },
          ),
          animate(
            band,
            { opacity: [0, 1] },
            { duration: dur.base, ease: ease.out, delay: dur.fast },
          ),
        );
      }
    }
    const finish = () => {
      for (const monitor of monitors) monitor.style.transform = '';
      setDone(true);
    };
    Promise.all(runs).then(finish, finish);
    return () => {
      for (const run of runs) run.stop();
      for (const monitor of monitors) {
        monitor.style.transform = '';
        monitor.style.opacity = '';
      }
      if (band) band.style.opacity = '';
      ghost?.remove();
    };
  }, [projectId]);

  if (done) return null;
  return <div ref={ref} aria-hidden inert data-office-entry className="os-entry" />;
}

/** A still copy of the room for the entry: no ids, hooks or controls a test or reader could find. */
function stillCopy(room: HTMLElement): HTMLElement {
  const copy = room.cloneNode(true) as HTMLElement;
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
    el.removeAttribute('id');
    el.removeAttribute('tabindex');
    for (const name of el.getAttributeNames()) {
      if (/^data-(scene|office|room|focus|band)/.test(name)) el.removeAttribute(name);
    }
  }
  copy.dataset.officeGhost = '';
  return copy;
}

const officeSkin: WorkspaceSkin = {
  HeaderBand: OfficeHeaderBand,
  PanelFrame: OfficePanelFrame,
  EntryTransition: OfficeEntry,
  HubCrew: OfficeHubCrew,
};

export default officeSkin;
