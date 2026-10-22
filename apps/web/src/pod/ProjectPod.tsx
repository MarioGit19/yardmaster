import type { ClaudeSession, Project, Terminal } from '@c-board/protocol';
import { ArrowDown, ArrowUp, GitBranch } from 'lucide-react';
import { motion } from 'motion/react';
import { type PointerEvent, useRef } from 'react';
import { Link } from 'wouter';
import { useNow } from '../anim/clock.js';
import { CrewMascot } from '../crew/CrewMascot.js';
import { miniCrewCount } from '../crew/model.js';
import { selectSessionsByProject, selectTerminalsByProject, useBoardList } from '../data/index.js';
import { POD_LAYOUT_DEPENDENCY, sharedId } from '../focus/shared.js';
import { TerminalLane } from '../lanes/TerminalLane.js';
import { spring } from '../motion.js';
import { projectHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { projectTone, toneLabel } from '../status.js';
import { cx } from '../ui/cx.js';
import { Skeleton } from '../ui/Skeleton.js';
import { MAX_SESSION_ROWS, podSessions } from './model.js';
import { SessionRow } from './SessionRow.js';
import { useMascotState } from './useMascotState.js';

/** Lanes shown per pod before the rest collapse into a count. */
const MAX_LANES = 4;
/** Header crew members; the rest of the sessions still have their rows. */
const MAX_CREW = 3;
/** The sleeping check only needs to notice five quiet minutes. */
const CREW_CLOCK_MS = 30_000;
const SPOTLIGHT_PX = 320;
const CREW_PX = 56;
/** CrewMascot draws mini crew members at 46% of its size. */
const MINI_PX = Math.round(CREW_PX * 0.46);

const BORDER = {
  wait: 'glow-st-wait',
  err: 'glow-st-err',
  work: 'border-st-work/40',
  tool: 'border-st-work/40',
  ok: '',
  idle: '',
} as const;

/**
 * A project on the overview, DESIGN.md §4.3: accent hairline, a header with the crew,
 * session rows and terminal lanes. The border takes the most urgent status (wait > err > work).
 */
export function ProjectPod({ project }: { project: Project }) {
  const sessions = useBoardList(selectSessionsByProject(project.id));
  const terminals = useBoardList(selectTerminalsByProject(project.id));
  const openTerminals = terminals
    .filter((t) => t.state === 'open')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const tone = projectTone(sessions, terminals);
  const live = podSessions(sessions);
  const accent = `var(--accent-${project.accent})`;
  const hiddenSessions = live.length - MAX_SESSION_ROWS;
  const hiddenLanes = openTerminals.length - MAX_LANES;

  // The spotlight follows the pointer by transform on its own layer: no style recalc below it.
  const spotRef = useRef<HTMLDivElement>(null);
  // While it morphs back from the focus view, the pod flies over its neighbours.
  const podRef = useRef<HTMLElement>(null);
  const raise = (on: boolean) => {
    const slot = podRef.current?.parentElement;
    if (slot) slot.style.zIndex = on ? '20' : '';
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const spot = spotRef.current;
    if (!spot || e.pointerType !== 'mouse') return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left - SPOTLIGHT_PX / 2;
    const y = e.clientY - box.top - SPOTLIGHT_PX / 2;
    spot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  // The name link stretches over the pod; rows and lanes sit above it so their controls stay
  // usable. No overflow clipping on the pod itself: lane peeks hang below their lane.
  // The pod, its header and its orbs morph into the focus view (`focus/shared.ts`).
  return (
    <motion.article
      layoutId={sharedId.container(project.id)}
      layoutDependency={POD_LAYOUT_DEPENDENCY}
      transition={spring.smooth}
      onLayoutAnimationStart={() => raise(true)}
      onLayoutAnimationComplete={() => raise(false)}
      ref={podRef}
      data-pod={project.id}
      data-tone={tone}
      aria-label={`${project.name}, ${toneLabel(tone).toLowerCase()}`}
      onPointerMove={onPointerMove}
      style={{ '--accent': accent, borderRadius: 16 } as React.CSSProperties}
      className={cx(
        'pod group relative flex h-full min-w-0 flex-col gap-4 rounded-panel border border-line bg-bg-1 p-4 shadow-raised',
        'transition-[border-color] duration-150 ease-out hover:border-line-strong',
        BORDER[tone],
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-panel"
      >
        <div
          ref={spotRef}
          className="pod-spotlight"
          style={{ width: SPOTLIGHT_PX, height: SPOTLIGHT_PX }}
        />
      </div>

      <motion.header
        layoutId={sharedId.header(project.id)}
        layoutDependency={POD_LAYOUT_DEPENDENCY}
        transition={spring.smooth}
        className="flex min-w-0 items-center gap-3"
      >
        <ProjectAvatar project={project} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Link
            href={projectHref(project.id)}
            title={project.name}
            className="truncate font-medium text-title-sm text-text-1 after:absolute after:inset-0 after:rounded-panel focus-visible:shadow-none focus-visible:after:shadow-focus"
          >
            {project.name}
          </Link>
          <GitLine git={project.git} />
        </div>
        <PodCrew sessions={live.slice(0, MAX_CREW)} terminals={terminals} accent={accent} />
      </motion.header>

      {live.length > 0 ? (
        <ul aria-label="Claude sessions" className="relative z-[1] flex flex-col gap-3">
          {live.slice(0, MAX_SESSION_ROWS).map((session) => (
            <SessionRow key={session.id} session={session} accent={accent} />
          ))}
          {hiddenSessions > 0 && (
            <li className="pl-10 text-meta text-text-3 tabular">
              {hiddenSessions} more {hiddenSessions === 1 ? 'session' : 'sessions'}
            </li>
          )}
        </ul>
      ) : (
        <p className="text-body-sm text-text-3">No Claude sessions</p>
      )}

      {openTerminals.length > 0 ? (
        <div className="lanes relative z-[1] mt-auto">
          <ul aria-label="Terminals" className="flex flex-col">
            {openTerminals.slice(0, MAX_LANES).map((terminal) => (
              <TerminalLane key={terminal.id} terminal={terminal} accent={accent} />
            ))}
          </ul>
          {hiddenLanes > 0 && (
            <p className="mt-1 pl-[18px] text-meta text-text-3 tabular">
              {hiddenLanes} more {hiddenLanes === 1 ? 'terminal' : 'terminals'}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-auto text-meta text-text-3">No open terminals</p>
      )}
    </motion.article>
  );
}

function GitLine({ git }: { git: Project['git'] }) {
  if (!git) return <span className="text-meta text-text-3">Not a git repository</span>;
  const branch = git.branch ?? (git.head ? git.head.slice(0, 7) : 'no branch');
  return (
    <span className="flex min-w-0 items-center gap-2.5 font-mono text-meta text-text-3 tabular">
      <span className="flex min-w-0 items-center gap-1" title={branch}>
        <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
        <span className="truncate text-text-2">{branch}</span>
      </span>
      {git.dirty > 0 && (
        <span
          className="flex shrink-0 items-center gap-1"
          title={`${git.dirty} changed ${git.dirty === 1 ? 'file' : 'files'}`}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-text-3" />
          {git.dirty}
          <span className="sr-only"> changed</span>
        </span>
      )}
      {git.ahead > 0 && (
        <span className="flex shrink-0 items-center" title={`${git.ahead} ahead of upstream`}>
          <ArrowUp aria-hidden className="size-3" strokeWidth={1.75} />
          {git.ahead}
          <span className="sr-only"> ahead</span>
        </span>
      )}
      {git.behind > 0 && (
        <span className="flex shrink-0 items-center" title={`${git.behind} behind upstream`}>
          <ArrowDown aria-hidden className="size-3" strokeWidth={1.75} />
          {git.behind}
          <span className="sr-only"> behind</span>
        </span>
      )}
    </span>
  );
}

/** The project's crew in the header: one per live session, or one for the project itself. */
function PodCrew({
  sessions,
  terminals,
  accent,
}: {
  sessions: readonly ClaudeSession[];
  terminals: readonly Terminal[];
  accent: string;
}) {
  const now = useNow(CREW_CLOCK_MS);
  const crew = sessions.length > 0 ? sessions : [null];
  return (
    <div className="-my-2 flex shrink-0 items-end">
      {crew.map((session, i) => (
        <CrewMember
          key={session?.id ?? 'project'}
          session={session}
          terminals={terminals}
          accent={accent}
          now={now}
          overlap={i > 0}
        />
      ))}
    </div>
  );
}

function CrewMember({
  session,
  terminals,
  accent,
  now,
  overlap,
}: {
  session: ClaudeSession | null;
  terminals: readonly Terminal[];
  accent: string;
  now: number;
  overlap: boolean;
}) {
  const state = useMascotState(session, terminals, now);
  const subagents = session?.subagents.filter((a) => a.status === 'running').length ?? 0;
  // Mini crew members stand to the right of their parent; keep room for them in the header.
  const minis = miniCrewCount(state, subagents);
  const room = minis > 0 ? MINI_PX + (minis - 1) * MINI_PX * 0.62 : 0;
  return (
    <span className={cx('flex shrink-0', overlap && '-ml-3')} style={{ marginRight: room }}>
      <CrewMascot
        state={state}
        size={CREW_PX}
        color={accent}
        tool={session?.status.kind === 'tool' ? session.status.tool : null}
        subagents={subagents}
      />
    </span>
  );
}

/** Pod-shaped loading placeholder. */
export function ProjectPodSkeleton() {
  return (
    <div
      aria-hidden
      className="flex flex-col gap-4 rounded-panel border border-line bg-bg-1 p-4 shadow-raised"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="size-6 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="size-10 rounded-full" />
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="size-7 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
      <Skeleton className="mt-2 h-3 w-full" />
      <Skeleton className="h-3 w-full" />
    </div>
  );
}
