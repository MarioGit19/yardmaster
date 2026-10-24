import { ArrowLeft, Check, Maximize2, Minimize2, SquareArrowOutUpRight } from 'lucide-react';
import { animate } from 'motion/react';
import {
  lazy,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Link } from 'wouter';
import { OffstageContext } from '../anim/useFrame.js';
import { attentionOpen } from '../attention/attention.js';
import { ClaudePanel } from '../claude/ClaudePanel.js';
import { toolSummary } from '../claude/transcript.js';
import { useTranscript } from '../claude/useTranscript.js';
import { selectSession, selectTerminal, useBoard } from '../data/index.js';
import { DecryptedText } from '../fx/DecryptedText.js';
import { formatUptime } from '../lanes/lane.js';
import { TerminalPeek } from '../lanes/TerminalPeek.js';
import { ActorInspector } from '../layouts/ActorInspector.js';
import {
  actorKindName,
  actorStateLabel,
  type SceneActor,
  type SceneProject,
} from '../layouts/scene.js';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
import { LiveCaption } from '../pod/LiveCaption.js';
import { PortButton } from '../ports/PortButton.js';
import { projectHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { isTypingTarget } from '../shell/railNav.js';
import { toneLabel } from '../status.js';
import { CommandLine, useTerminalAction, useTerminalView } from '../terminal/TerminalStack.js';
import { buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import { SwipePager } from '../ui/SwipePager.js';
import { Tooltip } from '../ui/Tooltip.js';
import { ARC_DROP, planCockpit } from './map.js';

/** Messages the Claude screen keeps: the newest few, like a monitor's last lines. */
const MESSAGE_ROWS = 5;

const SMALL_LABEL: Record<string, string> = { git: 'Git', ports: 'Ports', todo: 'Todo' };

/** The centered terminal mounts xterm only when it's asked for: one at a time. */
const XtermView = lazy(() => import('../terminal/XtermView.js'));

/** A screen brought to the center, and where it flew from. */
interface Centered {
  actorId: string;
  from: DOMRect;
}

export interface FlatCockpitProps {
  project: SceneProject;
  now: number;
  /** A phone or a tablet: the screens are one swipeable row instead of an arc. */
  narrow: boolean;
  /**
   * The 3D cockpit at the end of the dive: the arc curves round the viewer in CSS 3D, the screens
   * phase in, and the page's one WebGL context stays with the network behind it.
   */
  deep?: boolean;
  onBack(): void;
}

/**
 * The flat cockpit (DESIGN.md §10.4 step 3, laid out in 2D): the project's screens in an arc,
 * the Claude screen in the middle with its live messages, terminal screens to the sides with
 * their live tails, ports and uptime, and small git, ports and todo screens above. Every screen's
 * title opens the Actor inspector; "Open workspace" goes to the focus view. On a phone the
 * screens are a stack of full-width pages you swipe through.
 */
export function FlatCockpit({ project, now, narrow, deep = false, onBack }: FlatCockpitProps) {
  const plan = planCockpit(project.actors);
  // One screen beside the middle one: the two sit side by side, centered as a pair, instead of
  // leaving the arc's left side empty.
  const pair = plan.left.length === 0 && plan.right.length > 0;
  const [centered, setCentered] = useState<Centered | null>(null);
  const centerActor = centered
    ? project.actors.find((a) => a.id === centered.actorId && !a.parentId)
    : undefined;
  const arcRef = useRef<HTMLDivElement>(null);

  const bringToCenter = useCallback((actorId: string, el: HTMLElement) => {
    setCentered({ actorId, from: el.getBoundingClientRect() });
  }, []);
  // Back to the arc, with focus on the screen it came from (the screen itself, not its button,
  // whose tooltip would take the next Esc).
  const backToArc = useCallback(() => {
    setCentered((current) => {
      if (current) {
        requestAnimationFrame(() =>
          arcRef.current
            ?.querySelector<HTMLElement>(`[data-screen-actor="${CSS.escape(current.actorId)}"]`)
            ?.focus({ preventScroll: true }),
        );
      }
      return null;
    });
  }, []);

  // A screen whose actor left the project goes back to the arc.
  useEffect(() => {
    if (centered && !centerActor) setCentered(null);
  }, [centered, centerActor]);

  // Esc from anywhere but the centered screen itself (which handles its own, after its fields
  // have had their say) steps back to the arc before the layout's Esc leaves the cockpit. Not
  // while the workspace covers the cockpit: Esc there goes back to it.
  const offstage = useContext(OffstageContext);
  const offstageRef = useRef(offstage);
  offstageRef.current = offstage;
  useEffect(() => {
    if (!centered) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || offstageRef.current) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as Element | null;
      if (target?.closest?.('[data-grid-center]')) return;
      if (isTypingTarget(target) || attentionOpen.get() === 'open') return;
      if (document.querySelector('[data-actor-inspector], [role="dialog"]')) return;
      event.preventDefault();
      backToArc();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [centered, backToArc]);

  const screen = (actor: SceneActor) =>
    actor.kind === 'terminal' ? (
      <TerminalScreen
        key={actor.id}
        actor={actor}
        project={project}
        now={now}
        onCenter={bringToCenter}
      />
    ) : (
      <ClaudeScreen
        key={actor.id}
        actor={actor}
        project={project}
        kids={plan.children.get(actor.id) ?? []}
        onCenter={bringToCenter}
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
      data-deep={deep ? '' : undefined}
      data-centered={centered?.actorId}
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
            {deep ? <DecryptedText text={project.name} resolveOnMount /> : project.name}
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
          // With a screen centered, Esc from the workspace comes back to that screen's link.
          data-focus-return={centerActor ? undefined : project.id}
          data-cockpit-open
          className={cx(buttonClass('primary', 'sm'), 'touch:min-h-11 max-md:w-full')}
        >
          <SquareArrowOutUpRight aria-hidden className="size-3.5" strokeWidth={1.75} />
          Open workspace
        </Link>
      </header>

      <div
        ref={arcRef}
        data-cockpit-arc
        data-dimmed={centerActor ? '' : undefined}
        inert={centerActor ? true : undefined}
        className="grid-cockpit-arc"
      >
        {narrow ? (
          <SwipePager
            label={`${project.name} screens`}
            data-cockpit-stack=""
            pages={[
              ...[...(plan.center ? [plan.center] : []), ...plan.right, ...plan.left].map(
                (actor) => ({
                  key: actor.id,
                  label: `${actor.label}, ${actorKindName(actor.kind)}`,
                  node: screen(actor),
                }),
              ),
              ...small.map((element) => ({
                key: String(element.key),
                label: SMALL_LABEL[String(element.key)] ?? String(element.key),
                node: element,
              })),
            ]}
          />
        ) : (
          <>
            <div data-cockpit-small className="grid grid-cols-3 gap-4 px-[12%]">
              {small}
            </div>
            <div
              data-cockpit-row={pair ? 'pair' : 'arc'}
              className={cx(
                'grid items-start gap-4',
                pair
                  ? 'mx-auto w-[calc((100%-2rem)*2.35/3.35+1rem)] grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]'
                  : 'grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1fr)]',
              )}
            >
              {!pair && <ArcColumn side="left" actors={plan.left} render={screen} />}
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
      </div>
      {centered && centerActor && (
        <CenterScreen
          key={centerActor.id}
          actor={centerActor}
          project={project}
          now={now}
          from={centered.from}
          deep={deep}
          onClose={backToArc}
        />
      )}
    </section>
  );
}

/**
 * The screen brought to the center (§10.4 step 4): it flies there from its place in the arc and
 * becomes the real thing: the terminal's xterm with its command line (the only xterm mounted in
 * the cockpit), or Claude's whole conversation with its composer. Esc or the button sends it back.
 */
function CenterScreen({
  actor,
  project,
  now,
  from,
  deep,
  onClose,
}: {
  actor: SceneActor;
  project: SceneProject;
  now: number;
  from: DOMRect;
  deep: boolean;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const level = useMotionLevel();
  // Fly from the arc: measure where it lands, then start it at the arc screen's box.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (level !== 'full') {
      if (level === 'off') return;
      const fade = animate(el, { opacity: [0, 1] }, { duration: dur.base, ease: ease.out });
      return () => fade.stop();
    }
    const to = el.getBoundingClientRect();
    const scale = Math.min(1, from.width / Math.max(1, to.width));
    const x = from.left + from.width / 2 - (to.left + to.width / 2);
    // Tops line up: the screen grows down out of where it sat in the arc.
    const y = from.top - to.top - (to.height * (1 - scale)) / 2;
    const fly = animate(
      el,
      { x: [x, 0], y: [y, 0], scale: [scale, 1], opacity: [0.4, 1] },
      spring.smooth,
    );
    return () => fly.stop();
  }, [from, level]);

  useEffect(() => {
    const el = ref.current;
    const frame = requestAnimationFrame(() =>
      (
        el?.querySelector<HTMLElement>('[data-command-line]:not(:disabled)') ??
        el?.querySelector<HTMLElement>('[data-composer] textarea') ??
        el?.querySelector<HTMLElement>('[data-center-close]')
      )?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  // Esc from inside: after the field it came from had its chance (a composer's own Esc).
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector('[data-actor-inspector]')) return;
    event.preventDefault();
    onClose();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc bubbling up from the screen's own controls.
    <div
      ref={ref}
      data-grid-center={actor.id}
      data-tone={actor.tone}
      onKeyDown={onKeyDown}
      className="grid-screen grid-center absolute inset-x-0 top-0 z-10 mx-auto flex min-h-0 w-full max-w-[60rem] flex-col"
    >
      <header className="flex min-h-10 min-w-0 shrink-0 items-center gap-2 border-line border-b px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ScreenTitle actor={actor} project={project} />
        </div>
        {actor.kind === 'terminal' && (
          <div className="flex shrink-0 items-center gap-2 font-mono text-meta text-text-3 tabular">
            <TerminalMeta actor={actor} now={now} />
          </div>
        )}
        {/* The workspace, on this screen's session or terminal (DESIGN.md §10.8). */}
        {(actor.links.sessionId || actor.links.terminalId) && (
          <Link
            href={actor.links.href}
            data-focus-return={project.id}
            data-center-open
            className={cx(buttonClass('secondary', 'sm'), 'touch:min-h-11')}
          >
            <SquareArrowOutUpRight aria-hidden className="size-3.5" strokeWidth={1.75} />
            Open in workspace
          </Link>
        )}
        <Tooltip content="Back to the arc" shortcut="Esc">
          <button
            type="button"
            aria-label={`Send ${actor.label} back to the arc`}
            aria-keyshortcuts="Escape"
            data-center-close
            onClick={onClose}
            className={cx(buttonClass('ghost', 'sm', { square: true }), 'size-11 md:size-8')}
          >
            <Minimize2 aria-hidden className="size-4" strokeWidth={1.5} />
          </button>
        </Tooltip>
      </header>
      {actor.kind === 'terminal' && actor.links.terminalId ? (
        <CenterTerminal terminalId={actor.links.terminalId} label={actor.label} deep={deep} />
      ) : actor.links.sessionId ? (
        <CenterClaude sessionId={actor.links.sessionId} />
      ) : (
        <p className="p-3 text-body-sm text-text-2">{actor.caption?.text ?? 'Nothing to show'}</p>
      )}
    </div>
  );
}

function CenterTerminal({
  terminalId,
  label,
  deep,
}: {
  terminalId: string;
  label: string;
  deep: boolean;
}) {
  const terminal = useBoard(selectTerminal(terminalId));
  if (!terminal) return null;
  return <CenterTerminalBody terminal={terminal} label={label} deep={deep} />;
}

function CenterTerminalBody({
  terminal,
  label,
  deep,
}: {
  terminal: NonNullable<ReturnType<ReturnType<typeof selectTerminal>>>;
  label: string;
  deep: boolean;
}) {
  const { view } = useTerminalView(terminal);
  const act = useTerminalAction();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          <XtermView
            terminalId={terminal.id}
            label={`Output of ${label}`}
            prefer={deep ? 'dom' : 'webgl'}
          />
        </Suspense>
      </div>
      <CommandLine
        terminal={terminal}
        running={view.running ? view.command : null}
        onInterrupt={() => act({ kind: 'terminal.interrupt', terminalId: terminal.id })}
      />
    </div>
  );
}

function CenterClaude({ sessionId }: { sessionId: string }) {
  const session = useBoard(selectSession(sessionId));
  if (!session) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ClaudePanel session={session} compact />
    </div>
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
  onCenter,
}: {
  kind: string;
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  actor?: SceneActor;
  onCenter?: (actorId: string, el: HTMLElement) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const center = actor && onCenter && (() => ref.current && onCenter(actor.id, ref.current));
  return (
    <section
      ref={ref}
      data-grid-screen={kind}
      data-screen-actor={actor?.id}
      data-tone={actor?.tone}
      tabIndex={center ? -1 : undefined}
      className="grid-screen flex min-w-0 flex-col outline-none"
    >
      <header className="flex min-h-9 min-w-0 items-center gap-2 border-line border-b px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">{title}</div>
        {meta && (
          <div className="flex shrink-0 items-center gap-2 font-mono text-meta text-text-3 tabular">
            {meta}
          </div>
        )}
        {center && actor && (
          <Tooltip content="Bring to the center">
            <button
              type="button"
              aria-label={`Bring ${actor.label} to the center`}
              data-screen-center={actor.id}
              onClick={center}
              className={cx(
                buttonClass('ghost', 'sm', { square: true }),
                '-mr-1.5 size-11 shrink-0 md:size-7',
              )}
            >
              <Maximize2 aria-hidden className="size-3.5" strokeWidth={1.5} />
            </button>
          </Tooltip>
        )}
      </header>
      {center ? (
        // The screen's face is a big target for the pointer; the keyboard has the button above.
        // biome-ignore lint/a11y/useKeyWithClickEvents: the header's center button is the keyboard path.
        // biome-ignore lint/a11y/noStaticElementInteractions: see above.
        <div
          data-screen-face
          onClick={(event) => {
            if (window.getSelection()?.isCollapsed === false) return;
            if ((event.target as Element).closest('button, a')) return;
            center();
          }}
          className="flex min-w-0 cursor-pointer flex-col gap-2 p-3"
        >
          {children}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-2 p-3">{children}</div>
      )}
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
          className="-mx-1.5 flex min-h-8 min-w-0 items-center gap-2 rounded-control px-1.5 text-left outline-none transition-colors duration-fast hover:bg-bg-2 focus-visible:ring-2 focus-visible:ring-line-strong touch:min-h-11"
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
  onCenter,
}: {
  actor: SceneActor;
  project: SceneProject;
  kids: SceneActor[];
  onCenter?: (actorId: string, el: HTMLElement) => void;
}) {
  const sessionId = actor.links.sessionId;
  return (
    <Screen
      kind="claude"
      actor={actor}
      title={<ScreenTitle actor={actor} project={project} />}
      onCenter={sessionId ? onCenter : undefined}
    >
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
                    className="flex min-h-7 max-w-full items-center gap-1.5 rounded-chip border border-line border-dashed px-2 text-label text-text-2 transition-colors duration-fast hover:bg-bg-2 touch:min-h-11"
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

function TerminalMeta({ actor, now }: { actor: SceneActor; now: number }) {
  const uptime = formatUptime(now - (actor.runningSince ?? actor.since));
  return (
    <>
      {actor.ports.map((port) => (
        <PortButton
          key={port}
          port={port}
          fineOnly
          className="relative inline-flex cursor-pointer items-center gap-1 rounded-chip text-st-ok-ink transition-colors duration-fast hover:text-text-1"
        >
          <span data-screen-port={port}>:{port}</span>
        </PortButton>
      ))}
      <span title={actor.runningSince ? 'Running for' : 'Open for'}>{uptime}</span>
    </>
  );
}

function TerminalScreen({
  actor,
  project,
  now,
  onCenter,
}: {
  actor: SceneActor;
  project: SceneProject;
  now: number;
  onCenter?: (actorId: string, el: HTMLElement) => void;
}) {
  const terminalId = actor.links.terminalId;
  return (
    <Screen
      kind="terminal"
      actor={actor}
      title={<ScreenTitle actor={actor} project={project} />}
      meta={<TerminalMeta actor={actor} now={now} />}
      onCenter={terminalId ? onCenter : undefined}
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
            <li key={port} className="flex">
              <PortButton
                port={port}
                fineOnly
                className="inline-flex cursor-pointer items-center gap-1 rounded-chip border border-line px-1.5 font-mono text-label text-st-ok-ink tabular transition-colors duration-fast hover:border-line-strong"
              >
                :{port}
              </PortButton>
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
