import type { ClaudeSession } from '@c-board/protocol';
import { ArrowLeft, GitBranch } from 'lucide-react';
import { motion } from 'motion/react';
import { Link } from 'wouter';
import { runningHelpers } from '../../background/model.js';
import { CrewMascot } from '../../crew/CrewMascot.js';
import { miniCrewCount } from '../../crew/model.js';
import { activityKey } from '../../data/index.js';
import { spring } from '../../motion.js';
import { DoneSweep } from '../../pod/PodActivity.js';
import type { CrewView } from '../../pod/SessionCrew.js';
import { useMascotState } from '../../pod/useMascotState.js';
import { routes } from '../../routes.js';
import { ProjectAvatar } from '../../shell/ProjectAvatar.js';
import { buttonClass } from '../../ui/Button.js';
import { Chip } from '../../ui/Chip.js';
import { Tooltip } from '../../ui/Tooltip.js';
import { FocusCaption } from '../FocusCaption.js';
import { sharedId } from '../shared.js';
import type { HeaderBandProps, WorkspaceSkin } from './types.js';

/** The header's crew member: full acting with props in detail (DESIGN.md §4.11). */
const HEADER_CREW_PX = 120;

/** The standard header (DESIGN.md §4.6): the pod's header grown into the view's. */
function MinimalHeaderBand({
  project,
  session,
  composing,
  accent,
  crew,
  now,
  headingRef,
  shared,
}: HeaderBandProps) {
  return (
    <motion.header
      layoutId={shared ? sharedId.header(project.id) : undefined}
      transition={spring.smooth}
      className="relative flex min-w-0 shrink-0 items-center gap-3 border-line border-b px-4 py-3 md:px-5"
    >
      {session && <DoneSweep key={session.id} pulseKey={activityKey.session(session.id)} />}
      <Tooltip content="Back to the overview" shortcut="Esc">
        <Link
          href={routes.overview}
          aria-label="Back to the overview"
          className={buttonClass('ghost', 'sm', { square: true })}
        >
          <ArrowLeft className="size-4" strokeWidth={1.5} />
        </Link>
      </Tooltip>
      <ProjectAvatar project={project} size="lg" />
      <div className="flex min-w-0 flex-1 flex-col">
        <h1
          ref={headingRef}
          tabIndex={-1}
          title={project.name}
          className="truncate font-medium text-title text-text-1 outline-none focus-visible:shadow-none"
        >
          {project.name}
        </h1>
        <p className="truncate font-mono text-meta text-text-2" title={project.path}>
          {project.path}
        </p>
      </div>
      <HeaderCrew
        key={composing ? 'new' : (session?.id ?? 'project')}
        session={session}
        accent={accent}
        crew={crew}
        now={now}
      />
      {session && session.status.kind !== 'ended' && (
        <div className="hidden min-w-0 max-w-[32rem] flex-[1.4] md:block">
          <FocusCaption session={session} />
        </div>
      )}
      {project.git?.branch && (
        <span className="hidden min-w-0 max-w-60 sm:flex">
          <Chip mono icon={<GitBranch />} title={project.git.branch}>
            {project.git.branch}
          </Chip>
        </span>
      )}
    </motion.header>
  );
}

/**
 * The focused session's crew member at full size (DESIGN.md §4.11), acting out the turn with its
 * props and playing the done sparkle when it finishes. The project's own crew while composing.
 */
function HeaderCrew({
  session,
  accent,
  crew,
  now,
}: {
  session: ClaudeSession | null;
  accent: string;
  crew: CrewView;
  now: number;
}) {
  const state = useMascotState(session, crew.terminals, now);
  const subagents = session?.subagents.filter((a) => a.status === 'running').length ?? 0;
  // Mini crew members stand to the right at 46% size; keep room for them.
  const minis = miniCrewCount(state, subagents);
  const mini = HEADER_CREW_PX * 0.46;
  const room = minis > 0 ? mini + (minis - 1) * mini * 0.62 : 0;
  return (
    <span data-focus-crew className="-my-2 hidden shrink-0 md:flex" style={{ marginRight: room }}>
      <CrewMascot
        state={state}
        size={HEADER_CREW_PX}
        color={accent}
        tool={session?.status.kind === 'tool' ? session.status.tool : null}
        subagents={subagents}
        helpers={session ? runningHelpers(session) : undefined}
        activity={crew.activity}
      />
    </span>
  );
}

/** The reference skin: today's focus view, unchanged. */
export const minimalSkin: WorkspaceSkin = {
  HeaderBand: MinimalHeaderBand,
  PanelFrame: null,
  EntryTransition: null,
};
