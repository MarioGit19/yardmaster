import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import { useEffect, useRef } from 'react';
import { QUIET_LEVEL } from '../data/activity.js';
import { GlitchText } from '../fx/GlitchText.js';
import { ActorInspector } from '../layouts/ActorInspector.js';
import type { SceneActor, SceneProject } from '../layouts/scene.js';
import { LiveCaption } from '../pod/LiveCaption.js';
import { toneLabel } from '../status.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import { HEX_R, MAX_SATELLITES, nodeCaption, nodeCounts } from './map.js';
import { shownSatellites } from './network.js';

export interface GridNodeProps {
  project: SceneProject;
  /**
   * `map`: a fixed card on the ring; `trunk`: a full-width row on the phone's trunk; `float`: a
   * label over its 3D monolith, its satellite buttons placed over the 3D satellites by the
   * renderer.
   */
  variant: 'map' | 'trunk' | 'float';
  style?: CSSProperties;
  /** A click on the node (not on a satellite) or Enter on it: the cockpit. */
  onEnter(): void;
  onHover?(hovered: boolean): void;
}

/**
 * One project as a Grid node (DESIGN.md §10.4): a hexagon whose edge takes the priority status
 * color and whose core fills with activity, the name and branch (counts in a tip on hover), the busiest actor's
 * live caption, and a satellite per actor on a short sub-pipe (dashed for background work).
 * Waiting raises an amber beacon; an error glitches the name once and stays rose.
 */
export function GridNode({ project, variant, style, onEnter, onHover }: GridNodeProps) {
  const caption = nodeCaption(project);
  const counts = nodeCounts(project.actors);
  // Floating over the 3D network, each button rides its satellite: they keep a stable order.
  const shown =
    variant === 'float' ? shownSatellites(project.actors) : project.actors.slice(0, MAX_SATELLITES);
  const hidden = project.actors.length - shown.length;
  const branch = project.branch
    ? `${project.branch}${project.dirty > 0 ? ` ±${project.dirty}` : ''}`
    : null;

  // The time the node turned rose: each new error glitches the name once.
  const erredAt = useRef<number | undefined>(undefined);
  const wasErr = useRef(false);
  if (project.tone === 'err' && !wasErr.current) erredAt.current = Date.now();
  useEffect(() => {
    wasErr.current = project.tone === 'err';
  }, [project.tone]);

  // The node is one Tab stop; arrows move between its satellites, Enter opens the cockpit,
  // Esc on a satellite goes back to the node (§10.1).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const node = event.currentTarget;
    if (!node.contains(event.target as Node)) return;
    if (event.target === node) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onEnter();
        return;
      }
    } else if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      node.focus({ preventScroll: true });
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const buttons = [...node.querySelectorAll<HTMLElement>('[data-scene-actor]')];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    const next = index < 0 ? (step > 0 ? 0 : buttons.length - 1) : index + step;
    buttons[(next + buttons.length) % buttons.length]?.focus({ preventScroll: true });
  };

  // Anywhere on the node but a satellite opens the cockpit. Clicks inside an inspector bubble
  // here through its portal; those stay out.
  const onClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as Element;
    if (!event.currentTarget.contains(target)) return;
    if (target.closest('button, a, [data-scene-actor]')) return;
    onEnter();
  };

  return (
    <section
      aria-roledescription="node"
      aria-label={`${project.name}, ${toneLabel(project.tone)}, ${counts}`}
      aria-keyshortcuts="Enter"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: each node is one Tab stop (§10.1).
      tabIndex={0}
      data-grid-node={project.id}
      data-focus-return={project.id}
      data-tone={project.tone}
      data-dim={project.dim || undefined}
      data-variant={variant}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onPointerEnter={onHover && (() => onHover(true))}
      onPointerLeave={onHover && (() => onHover(false))}
      onFocus={onHover && (() => onHover(true))}
      onBlur={
        onHover &&
        ((event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHover(false);
        })
      }
      className={cx(
        'grid-node cursor-pointer outline-none',
        variant === 'map' ? 'absolute' : variant === 'trunk' ? 'relative' : undefined,
      )}
      style={{ '--accent': `var(--accent-${project.accent})`, ...style } as CSSProperties}
    >
      {project.tone === 'wait' && variant === 'map' && (
        <span aria-hidden data-grid-beacon className="grid-beacon" />
      )}
      {variant !== 'trunk' && (
        <span aria-hidden data-grid-tip className="grid-tip font-mono text-meta tabular">
          {counts}
        </span>
      )}
      <div className="flex min-w-0 items-start gap-2.5">
        {variant !== 'float' && <Hex project={project} />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <h2 className="flex min-w-0 items-center gap-2">
            <span
              className={cx(
                'min-w-0 truncate font-medium text-body-sm',
                project.tone === 'err' ? 'text-st-err-ink' : 'text-text-1',
              )}
              title={project.name}
            >
              {project.tone === 'err' ? (
                <GlitchText burst={erredAt.current}>{project.name}</GlitchText>
              ) : (
                project.name
              )}
            </span>
            <StatusDot
              tone={project.tone}
              label={toneLabel(project.tone)}
              className="ml-auto shrink-0"
            />
          </h2>
          <p className="grid-node-meta truncate font-mono text-meta text-text-3 tabular">
            {branch ?? 'No branch'}
          </p>
        </div>
      </div>
      <LiveCaption caption={caption} className="grid-node-meta mt-1.5 text-meta" />
      {project.actors.length > 0 && (
        <ul aria-label={`${project.name} actors`} className="grid-satellites">
          {shown.map((actor) => (
            <li
              key={actor.id}
              className="grid-satellite-slot"
              data-kind={actor.kind}
              data-grid-slot={actor.id}
            >
              <Satellite actor={actor} projectName={project.name} />
            </li>
          ))}
          {hidden > 0 && (
            <li className="grid-satellite-slot" data-kind="more" data-grid-slot-more>
              <span
                role="img"
                aria-label={`${hidden} more in ${project.name}`}
                data-grid-more={hidden}
                className="grid-more font-mono text-meta text-text-2 tabular"
              >
                +{hidden}
              </span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** Flat-topped hexagon points around (0, 0). */
const hexPoints = (r: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return `${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');

const HEX_OUTER = hexPoints(HEX_R);
const HEX_INNER = hexPoints(HEX_R - 5);

function Hex({ project }: { project: SceneProject }) {
  const activity = Math.max(project.activity, ...project.actors.map((a) => a.activity));
  const size = HEX_R * 2 + 6;
  return (
    <svg
      aria-hidden
      data-grid-hex
      className="grid-hex shrink-0"
      width={size}
      height={size}
      viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
    >
      <polygon className="grid-hex-edge" points={HEX_OUTER} />
      <polygon
        className="grid-hex-core"
        points={HEX_INNER}
        style={{ opacity: 0.15 + 0.75 * activity }}
      />
    </svg>
  );
}

const SHAPE: Record<SceneActor['kind'], string> = {
  claude: 'Claude session',
  subagent: 'subagent',
  background: 'background task',
  terminal: 'terminal',
};

function Satellite({ actor, projectName }: { actor: SceneActor; projectName: string }) {
  const active = actor.activity >= QUIET_LEVEL;
  return (
    <ActorInspector
      projectId={actor.projectId}
      actorId={actor.id}
      label={`${projectName}, ${actor.label}`}
      trigger={
        <button
          type="button"
          tabIndex={-1}
          aria-label={actor.name}
          title={`${actor.label} · ${actor.caption.text}`}
          data-scene-actor={actor.id}
          data-actor-state={actor.state}
          data-actor-kind={actor.kind}
          data-active={active || undefined}
          data-tone={actor.tone}
          data-shape={SHAPE[actor.kind]}
          className="grid-satellite"
        >
          <svg aria-hidden viewBox="-8 -8 16 16" className="grid-satellite-mark">
            {actor.kind === 'terminal' ? (
              <rect x={-4.5} y={-4.5} width={9} height={9} rx={1.5} />
            ) : actor.kind === 'background' ? (
              <rect x={-3.5} y={-3.5} width={7} height={7} transform="rotate(45)" />
            ) : (
              <circle r={actor.kind === 'claude' ? 5 : 3.25} />
            )}
          </svg>
        </button>
      }
    />
  );
}
