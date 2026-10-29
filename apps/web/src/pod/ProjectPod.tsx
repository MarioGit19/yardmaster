import type { ClaudeSession, EditorApp, Project } from '@yardmaster/protocol';
import { ArrowDown, ArrowUp, GitBranch } from 'lucide-react';
import { motion } from 'motion/react';
import { type PointerEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { useNow } from '../anim/clock.js';
import { useInView } from '../anim/useFrame.js';
import { runningBackground, runningHelpers } from '../background/model.js';
import { CrewMascot } from '../crew/CrewMascot.js';
import { type CrewTerminal, miniCrewCount } from '../crew/model.js';
import { useCrewTerminals } from '../crew/useCrewTerminals.js';
import {
  activityKey,
  selectCrashedCount,
  selectSessionsByProject,
  selectTerminalsByProject,
  useBoard,
  useBoardList,
  useLastActivity,
} from '../data/index.js';
import { POD_LAYOUT_DEPENDENCY, sharedId } from '../focus/shared.js';
import { GIT_SKIPPED } from '../git/model.js';
import { TerminalLane } from '../lanes/TerminalLane.js';
import { type OpeningPhase, slowHint, useOpening } from '../library/opening.js';
import { spring } from '../motion.js';
import { projectHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { formatCount, projectTone, toneLabel } from '../status.js';
import { cx } from '../ui/cx.js';
import { Skeleton } from '../ui/Skeleton.js';
import { isDimmed } from './activity.js';
import { MAX_SESSION_ROWS, podSessions } from './model.js';
import { ActivityBorder, DoneSweep, EventSparks } from './PodActivity.js';
import { PodMenu } from './PodMenu.js';
import { SessionRow } from './SessionRow.js';
import { useMascotState } from './useMascotState.js';

/** Lanes shown per pod before the rest collapse into a count. */
const MAX_LANES = 4;
/** Header crew members; the rest of the sessions still have their rows. */
const MAX_CREW = 3;
/** Sleeping crews and dimmed pods only need to notice five quiet minutes. */
const IDLE_CLOCK_MS = 15_000;
const WORKING = new Set<ClaudeSession['status']['kind']>(['working', 'tool', 'compacting']);
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
  const opening = useOpening(project.id);

  // Activity, DESIGN.md §4.10.
  const pulseKey = activityKey.project(project.id);
  const crashed = useBoard(selectCrashedCount(project.id)) > 0;
  // Background work keeps the border's light moving after the turn ends.
  const working = sessions.filter(
    (s) => WORKING.has(s.status.kind) || (isLive(s) && runningBackground(s) > 0),
  ).length;
  const now = useNow(IDLE_CLOCK_MS);
  // The crew watches streaming terminals and falls asleep after five quiet minutes (§4.11).
  const crew = useCrewTerminals(terminals);
  const lastPulse = useLastActivity(pulseKey);
  const lastActivity = Math.max(lastPulse ?? 0, project.lastActivityAt ?? 0) || null;
  // Nothing for five minutes: the pod steps back. Only its non-text layers (`.pod-dim`: avatar,
  // crew, orbs, sparklines) fade to 70%, so its text keeps its contrast. Pointing at it or
  // focusing inside brings it forward.
  const [engaged, setEngaged] = useState(false);
  const dim = isDimmed(tone, crashed, lastActivity, now);
  const faded = dim && !engaged;
  const sweeps = useRef(0);

  // The spotlight follows the pointer by transform on its own layer: no style recalc below it.
  const spotRef = useRef<HTMLDivElement>(null);
  // While it morphs back from the focus view, the pod flies over its neighbours.
  const podRef = useRef<HTMLElement>(null);
  // A waiting pod's breathing glow pauses off screen.
  const onScreen = useInView(podRef);
  const raise = (on: boolean) => {
    const slot = podRef.current?.parentElement;
    if (slot) slot.style.zIndex = on ? '20' : '';
  };
  // The pod's box, measured on pointer enter rather than per move; a scroll, a resize or a
  // layout animation moves the pod, so they drop it and the next move measures again.
  const spotBox = useRef<DOMRect | null>(null);
  useEffect(() => {
    if (!engaged) return;
    const forget = () => {
      spotBox.current = null;
    };
    window.addEventListener('resize', forget);
    window.addEventListener('scroll', forget, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', forget);
      window.removeEventListener('scroll', forget, { capture: true });
    };
  }, [engaged]);
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const spot = spotRef.current;
    if (!spot || e.pointerType !== 'mouse') return;
    spotBox.current ??= e.currentTarget.getBoundingClientRect();
    const box = spotBox.current;
    const x = e.clientX - box.left - SPOTLIGHT_PX / 2;
    const y = e.clientY - box.top - SPOTLIGHT_PX / 2;
    spot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  // The name link stretches over the pod; rows and lanes sit above it so their controls stay
  // usable. No overflow clipping on the pod itself: lane peeks hang below their lane.
  // The pod, its header and its orbs morph into the focus view (`focus/shared.ts`).
  return (
    <PodMenu project={project}>
      <motion.article
        layoutId={sharedId.container(project.id)}
        layoutDependency={POD_LAYOUT_DEPENDENCY}
        transition={spring.smooth}
        onPointerEnter={(e) => {
          spotBox.current = e.currentTarget.getBoundingClientRect();
          setEngaged(true);
        }}
        onPointerLeave={() => setEngaged(false)}
        onFocus={() => setEngaged(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEngaged(false);
        }}
        onLayoutAnimationStart={() => {
          spotBox.current = null;
          raise(true);
        }}
        onLayoutAnimationComplete={() => {
          spotBox.current = null;
          raise(false);
        }}
        ref={podRef}
        data-pod={project.id}
        data-tone={tone}
        data-crashed={crashed || undefined}
        data-dim={dim || undefined}
        data-faded={faded || undefined}
        data-offscreen={!onScreen || undefined}
        aria-label={`${project.name}, ${toneLabel(tone).toLowerCase()}`}
        onPointerMove={onPointerMove}
        style={{ '--accent': accent, borderRadius: 16 } as React.CSSProperties}
        className={cx(
          'pod group relative flex h-full min-w-0 flex-col gap-4 rounded-panel border border-line bg-bg-1 p-4 shadow-raised',
          'transition-[border-color] duration-fast ease-out hover:border-line-strong',
          crashed && tone !== 'wait' ? BORDER.err : BORDER[tone],
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
        <ActivityBorder pulseKey={pulseKey} working={working} />
        <EventSparks pulseKey={pulseKey} />
        <DoneSweep
          pulseKey={pulseKey}
          onPlay={() => {
            // Counted on the element for the e2e check that each turn sweeps once.
            sweeps.current += 1;
            if (podRef.current) podRef.current.dataset.sweeps = String(sweeps.current);
          }}
        />

        <motion.header
          layoutId={sharedId.header(project.id)}
          layoutDependency={POD_LAYOUT_DEPENDENCY}
          transition={spring.smooth}
          className="flex min-w-0 items-center gap-3"
        >
          <span className="pod-dim flex shrink-0">
            <ProjectAvatar project={project} />
          </span>
          <div className="pod-title flex min-w-0 flex-1 flex-col">
            <Link
              href={projectHref(project.id)}
              title={project.name}
              className="truncate font-medium text-title-sm text-text-1 after:absolute after:inset-0 after:rounded-panel focus-visible:shadow-none focus-visible:after:shadow-focus"
            >
              {project.name}
            </Link>
            {opening ? <OpeningLine {...opening} /> : <GitLine git={project.git} />}
          </div>
          <PodCrew
            sessions={live.slice(0, MAX_CREW)}
            terminals={crew.terminals}
            activity={crew.activity}
            accent={accent}
            now={now}
          />
        </motion.header>

        {live.length > 0 ? (
          <ul aria-label="Claude sessions" className="relative z-[1] flex flex-col gap-3">
            {live.slice(0, MAX_SESSION_ROWS).map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                accent={accent}
                crew={crew}
                now={now}
              />
            ))}
            {hiddenSessions > 0 && (
              <li className="pl-10 text-meta text-text-2 tabular">
                {hiddenSessions} more {hiddenSessions === 1 ? 'session' : 'sessions'}
              </li>
            )}
          </ul>
        ) : (
          <p className="text-body-sm text-text-2">No Claude sessions</p>
        )}

        {openTerminals.length > 0 ? (
          <div className="lanes relative z-[1]">
            <ul aria-label="Terminals" className="flex flex-col">
              {openTerminals.slice(0, MAX_LANES).map((terminal) => (
                <TerminalLane key={terminal.id} terminal={terminal} accent={accent} />
              ))}
            </ul>
            {hiddenLanes > 0 && (
              <p className="mt-1 pl-[18px] text-meta text-text-2 tabular">
                {hiddenLanes} more {hiddenLanes === 1 ? 'terminal' : 'terminals'}
              </p>
            )}
          </div>
        ) : (
          <p className="text-meta text-text-2">No open terminals</p>
        )}
      </motion.article>
    </PodMenu>
  );
}

/** Launched from the board: waiting for the editor window's extension to connect. */
function OpeningLine({ editor, phase }: { editor: EditorApp; phase: OpeningPhase }) {
  return (
    <span
      role="status"
      data-pod-opening={phase}
      className={cx('truncate text-meta', phase === 'slow' ? 'text-st-wait-ink' : 'text-text-2')}
      title={phase === 'slow' ? slowHint(editor) : undefined}
    >
      {phase === 'slow' ? slowHint(editor) : `Opening in ${editor}…`}
    </span>
  );
}

function GitLine({ git }: { git: Project['git'] }) {
  if (!git) return <span className="text-meta text-text-2">Not a git repository</span>;
  if (git.statusSkipped) {
    return (
      <span className="truncate text-meta text-text-2" title={GIT_SKIPPED}>
        {GIT_SKIPPED}
      </span>
    );
  }
  const branch = git.branch ?? (git.head ? git.head.slice(0, 7) : 'no branch');
  return (
    <span className="flex min-w-0 items-center gap-2 font-mono text-meta text-text-2 tabular">
      <span className="flex min-w-[min(3rem,100%)] items-center gap-1" title={branch}>
        <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
        <span className="truncate">{branch}</span>
      </span>
      {git.dirty > 0 && (
        <span
          className="pod-git-dirty flex shrink-0 items-center gap-1"
          title={`${git.dirty} changed ${git.dirty === 1 ? 'file' : 'files'}`}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-text-3" />
          {formatCount(git.dirty)}
          <span className="sr-only"> changed</span>
        </span>
      )}
      {git.ahead > 0 && (
        <span
          className="pod-git-sync flex shrink-0 items-center"
          title={`${git.ahead} ahead of upstream`}
        >
          <ArrowUp aria-hidden className="size-3" strokeWidth={1.75} />
          {formatCount(git.ahead)}
          <span className="sr-only"> ahead</span>
        </span>
      )}
      {git.behind > 0 && (
        <span
          className="pod-git-sync flex shrink-0 items-center"
          title={`${git.behind} behind upstream`}
        >
          <ArrowDown aria-hidden className="size-3" strokeWidth={1.75} />
          {formatCount(git.behind)}
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
  activity,
  accent,
  now,
}: {
  sessions: readonly ClaudeSession[];
  terminals: readonly CrewTerminal[];
  activity: number;
  accent: string;
  now: number;
}) {
  const crew = sessions.length > 0 ? sessions : [null];
  return (
    <div className="pod-crew pod-dim -my-2 flex shrink-0 items-end">
      {crew.map((session, i) => (
        <CrewMember
          key={session?.id ?? 'project'}
          session={session}
          terminals={terminals}
          activity={activity}
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
  activity,
  accent,
  now,
  overlap,
}: {
  session: ClaudeSession | null;
  terminals: readonly CrewTerminal[];
  activity: number;
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
        helpers={session ? runningHelpers(session) : undefined}
        activity={activity}
      />
    </span>
  );
}

const isLive = (s: ClaudeSession) => s.status.kind !== 'ended' && s.status.kind !== 'interrupted';

/** Pod-shaped loading placeholder: the real pod's header, crew, session rows and lane tracks. */
export function ProjectPodSkeleton() {
  return (
    <div
      aria-hidden
      data-pod-skeleton
      className="flex flex-col gap-4 rounded-panel border border-line bg-bg-1 p-4 shadow-raised"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Skeleton className="size-6 shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Skeleton className="h-4 w-32 max-w-full" />
          <Skeleton className="h-3 w-20 max-w-full" />
        </div>
        {/* The crew mascot is CREW_PX (56px) square. */}
        <Skeleton className="-my-2 size-14 shrink-0 rounded-panel" />
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1].map((row) => (
          <div key={row} className="flex min-w-0 items-center gap-3">
            <Skeleton className="size-7 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className={cx('h-3.5', row === 0 ? 'w-3/4' : 'w-1/2')} />
              <Skeleton className={cx('h-3', row === 0 ? 'w-1/2' : 'w-2/3')} />
            </div>
          </div>
        ))}
      </div>
      <div className="lanes">
        {[0, 1].map((lane) => (
          <div key={lane} className="lane-row">
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="h-3 w-full" />
            <span />
            <Skeleton className="ml-auto size-1.5 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
