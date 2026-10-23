import { ArrowLeft, Check, SquareArrowOutUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { toolSummary } from '../claude/transcript.js';
import { useTranscript } from '../claude/useTranscript.js';
import { formatUptime } from '../lanes/lane.js';
import { TerminalPeek } from '../lanes/TerminalPeek.js';
import { ActorInspector } from '../layouts/ActorInspector.js';
import {
  actorKindName,
  actorStateLabel,
  type SceneActor,
  type SceneProject,
} from '../layouts/scene.js';
import { LiveCaption } from '../pod/LiveCaption.js';
import { projectHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { toneLabel } from '../status.js';
import { buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import { Tooltip } from '../ui/Tooltip.js';
import { ARC_DROP, planCockpit } from './map.js';

/** Messages the Claude screen keeps: the newest few, like a monitor's last lines. */
const MESSAGE_ROWS = 5;

export interface FlatCockpitProps {
  project: SceneProject;
  now: number;
  /** A phone: the screens are one swipeable row instead of an arc. */
  narrow: boolean;
  onBack(): void;
}

/**
 * The flat cockpit (DESIGN.md §10.4 step 3, laid out in 2D): the project's screens in an arc,
 * the Claude screen in the middle with its live messages, terminal screens to the sides with
 * their live tails, ports and uptime, and small git, ports and todo screens above. Every screen's
 * title opens the Actor inspector; "Open workspace" goes to the focus view. On a phone the
 * screens are a row you swipe through.
 */
export function FlatCockpit({ project, now, narrow, onBack }: FlatCockpitProps) {
  const plan = planCockpit(project.actors);
  const screen = (actor: SceneActor) =>
    actor.kind === 'terminal' ? (
      <TerminalScreen key={actor.id} actor={actor} project={project} now={now} />
    ) : (
      <ClaudeScreen
        key={actor.id}
        actor={actor}
        project={project}
        kids={plan.children.get(actor.id) ?? []}
      />
    );
  const small = [
    <GitScreen key="git" project={project} />,
    <PortsScreen key="ports" project={project} />,
    <TodoScreen key="todo" project={project} />,
  ];

  return (
    <section
      data-grid-cockpit={project.id}
      data-narrow={narrow || undefined}
      aria-label={`${project.name} cockpit`}
      tabIndex={-1}
      className="grid-cockpit flex flex-col gap-4 outline-none"
      style={{ '--accent': `var(--accent-${project.accent})` } as React.CSSProperties}
    >
      <header className="grid-screen flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <Tooltip content="Back to the network" shortcut="Esc">
          <button
            type="button"
            aria-label="Back to the network"
            aria-keyshortcuts="Escape"
            data-cockpit-back
            onClick={onBack}
            className={cx(buttonClass('ghost', 'sm', { square: true }), 'size-11 md:size-8')}
          >
            <ArrowLeft aria-hidden className="size-4" strokeWidth={1.5} />
          </button>
        </Tooltip>
        <ProjectAvatar project={project} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate font-medium text-text-1 text-title-sm" title={project.name}>
            {project.name}
          </h2>
          <StatusDot
            tone={project.tone}
            label={toneLabel(project.tone)}
            showLabel
            className="text-label text-text-2"
          />
        </div>
        <Link
          href={projectHref(project.id)}
          data-focus-return={project.id}
          data-cockpit-open
          className={cx(buttonClass('primary', 'sm'), 'max-md:min-h-11 max-md:w-full')}
        >
          <SquareArrowOutUpRight aria-hidden className="size-3.5" strokeWidth={1.75} />
          Open workspace
        </Link>
      </header>

      {narrow ? (
        <ul aria-label={`${project.name} screens`} className="grid-cockpit-stack">
          {[...(plan.center ? [plan.center] : []), ...plan.right, ...plan.left].map((actor) => (
            <li key={actor.id} className="grid-cockpit-card">
              {screen(actor)}
            </li>
          ))}
          {small.map((element) => (
            <li key={element.key} className="grid-cockpit-card">
              {element}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4 px-[12%]">{small}</div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1fr)] items-start gap-4">
            <ArcColumn side="left" actors={plan.left} render={screen} />
            <div className="min-w-0">
              {plan.center ? (
                screen(plan.center)
              ) : (
                <Screen kind="empty" title={<span className="text-text-2">Nothing running</span>}>
                  <p className="text-body-sm text-text-2">
                    No Claude session or terminal is open in this project.
                  </p>
                </Screen>
              )}
            </div>
            <ArcColumn side="right" actors={plan.right} render={screen} />
          </div>
        </>
      )}
    </section>
  );
}

/** One side of the arc: each screen further out sits a step lower, like panels curving round. */
function ArcColumn({
  side,
  actors,
  render,
}: {
  side: 'left' | 'right';
  actors: SceneActor[];
  render(actor: SceneActor): ReactNode;
}) {
  return (
    <div data-arc={side} className="flex min-w-0 flex-col gap-4" style={{ paddingTop: ARC_DROP }}>
      {actors.map((actor, i) => (
        <div key={actor.id} style={{ marginTop: i === 0 ? 0 : ARC_DROP / 2 }}>
          {render(actor)}
        </div>
      ))}
    </div>
  );
}

function Screen({
  kind,
  title,
  meta,
  children,
  actor,
}: {
  kind: string;
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  actor?: SceneActor;
}) {
  return (
    <section
      data-grid-screen={kind}
      data-screen-actor={actor?.id}
      data-tone={actor?.tone}
      className="grid-screen flex min-w-0 flex-col"
    >
      <header className="flex min-h-9 min-w-0 items-center gap-2 border-line border-b px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">{title}</div>
        {meta && (
          <div className="flex shrink-0 items-center gap-2 font-mono text-meta text-text-3 tabular">
            {meta}
          </div>
        )}
      </header>
      <div className="flex min-w-0 flex-col gap-2 p-3">{children}</div>
    </section>
  );
}

/** A screen's title: the actor's state and name, opening its inspector. */
function ScreenTitle({ actor, project }: { actor: SceneActor; project: SceneProject }) {
  return (
    <ActorInspector
      projectId={project.id}
      actorId={actor.id}
      label={`${project.name}, ${actor.label}`}
      trigger={
        <button
          type="button"
          aria-label={actor.name}
          data-scene-actor={actor.id}
          data-actor-state={actor.state}
          className="-mx-1.5 flex min-h-8 min-w-0 items-center gap-2 rounded-control px-1.5 text-left outline-none transition-colors duration-fast hover:bg-bg-2 focus-visible:ring-2 focus-visible:ring-line-strong max-md:min-h-11"
        >
          <StatusDot tone={actor.tone} label={actorStateLabel(actor)} />
          <span className="truncate font-medium text-body-sm text-text-1">{actor.label}</span>
          <span className="shrink-0 text-meta text-text-3">{actorKindName(actor.kind)}</span>
        </button>
      }
    />
  );
}

function ClaudeScreen({
  actor,
  project,
  kids,
}: {
  actor: SceneActor;
  project: SceneProject;
  kids: SceneActor[];
}) {
  const sessionId = actor.links.sessionId;
  return (
    <Screen kind="claude" actor={actor} title={<ScreenTitle actor={actor} project={project} />}>
      <LiveCaption caption={actor.caption} className="text-body-sm" />
      {sessionId && <Messages sessionId={sessionId} />}
      {kids.length > 0 && (
        <ul aria-label={`${actor.label}: running work`} className="flex flex-wrap gap-1.5">
          {kids.map((kid) => (
            <li key={kid.id} className="min-w-0 max-w-full">
              <ActorInspector
                projectId={project.id}
                actorId={kid.id}
                label={`${project.name}, ${kid.label}`}
                trigger={
                  <button
                    type="button"
                    aria-label={kid.name}
                    data-scene-actor={kid.id}
                    data-actor-state={kid.state}
                    className="flex min-h-7 max-w-full items-center gap-1.5 rounded-chip border border-line border-dashed px-2 text-label text-text-2 transition-colors duration-fast hover:bg-bg-2 max-md:min-h-11"
                  >
                    <StatusDot tone={kid.tone} label={actorStateLabel(kid)} />
                    <span className="truncate">{kid.label}</span>
                  </button>
                }
              />
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}

/** The session's newest messages and tool calls, one line each. */
function Messages({ sessionId }: { sessionId: string }) {
  const { rows, loaded } = useTranscript(sessionId);
  const tail = rows.filter((row) => row.kind !== 'thinking').slice(-MESSAGE_ROWS);
  return (
    <ol
      aria-label="Latest messages"
      data-grid-messages
      className="flex h-[7.5rem] flex-col justify-end gap-1 overflow-hidden text-label"
    >
      {loaded && tail.length === 0 && <li className="text-text-3">No messages yet</li>}
      {tail.map((row) => {
        switch (row.kind) {
          case 'user':
            return (
              <li key={row.id} className="truncate text-text-1">
                <span aria-hidden className="mr-1.5 text-text-3">
                  ›
                </span>
                {row.text}
              </li>
            );
          case 'assistant':
            return (
              <li key={row.id} className="truncate text-text-2">
                {row.text}
              </li>
            );
          case 'tool':
            return (
              <li key={row.id} className="truncate font-mono text-meta text-text-3">
                <span className={row.result?.isError ? 'text-st-err-ink' : 'text-st-tool-ink'}>
                  {row.name}
                </span>{' '}
                {toolSummary(row.name, row.input)}
              </li>
            );
          default:
            return null;
        }
      })}
    </ol>
  );
}

function TerminalScreen({
  actor,
  project,
  now,
}: {
  actor: SceneActor;
  project: SceneProject;
  now: number;
}) {
  const terminalId = actor.links.terminalId;
  const uptime = formatUptime(now - (actor.runningSince ?? actor.since));
  return (
    <Screen
      kind="terminal"
      actor={actor}
      title={<ScreenTitle actor={actor} project={project} />}
      meta={
        <>
          {actor.ports.map((port) => (
            <span key={port} data-screen-port={port} className="text-st-ok-ink">
              :{port}
            </span>
          ))}
          <span title={actor.runningSince ? 'Running for' : 'Open for'}>{uptime}</span>
        </>
      }
    >
      <LiveCaption caption={actor.caption} className="text-label" />
      {terminalId && (
        <TerminalPeek
          terminalId={terminalId}
          label={`${actor.label} output`}
          className="border-0! bg-transparent! px-0! py-0! shadow-none!"
        />
      )}
    </Screen>
  );
}

function GitScreen({ project }: { project: SceneProject }) {
  return (
    <Screen kind="git" title={<span className="text-label text-text-2">Git</span>}>
      <p className="truncate font-mono text-label text-text-1">{project.branch ?? 'No branch'}</p>
      <p className="text-meta text-text-3 tabular">
        {project.dirty === 0
          ? 'Clean'
          : `${project.dirty} uncommitted ${project.dirty === 1 ? 'file' : 'files'}`}
      </p>
    </Screen>
  );
}

function PortsScreen({ project }: { project: SceneProject }) {
  return (
    <Screen kind="ports" title={<span className="text-label text-text-2">Ports</span>}>
      {project.ports.length === 0 ? (
        <p className="text-meta text-text-3">Nothing listening</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {project.ports.map((port) => (
            <li
              key={port}
              className="rounded-chip border border-line px-1.5 font-mono text-label text-st-ok-ink tabular"
            >
              :{port}
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}

function TodoScreen({ project }: { project: SceneProject }) {
  const todos = project.todos.slice(0, 3);
  return (
    <Screen kind="todo" title={<span className="text-label text-text-2">Todo</span>}>
      {todos.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {todos.map((todo, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: todo lines have no id.
            <li key={i} className="flex min-w-0 items-center gap-1.5 text-label">
              <span
                aria-hidden
                className={cx(
                  'grid size-3 shrink-0 place-items-center rounded-[3px] border',
                  todo.done ? 'border-st-ok bg-st-ok-glow text-st-ok-ink' : 'border-line-strong',
                )}
              >
                {todo.done && <Check className="size-2.5" strokeWidth={3} />}
              </span>
              <span className={cx('truncate', todo.done ? 'text-text-3' : 'text-text-1')}>
                {todo.text}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="truncate text-meta text-text-3">{project.summary ?? 'No todo list'}</p>
      )}
    </Screen>
  );
}
