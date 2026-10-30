import { ArrowLeft, GitBranch } from 'lucide-react';
import { motion } from 'motion/react';
import { Link } from 'wouter';
import { activityKey } from '../../data/index.js';
import { spring } from '../../motion.js';
import { DoneSweep } from '../../pod/PodActivity.js';
import { routes } from '../../routes.js';
import { ProjectAvatar } from '../../shell/ProjectAvatar.js';
import { buttonClass } from '../../ui/Button.js';
import { Tooltip } from '../../ui/Tooltip.js';
import { FocusCaption, FocusStatus } from '../FocusCaption.js';
import { sharedId } from '../shared.js';
import type { HeaderBandProps, WorkspaceSkin } from './types.js';

/** The standard header (DESIGN.md §4.6): the pod's header grown into the view's. */
function MinimalHeaderBand({ project, session, headingRef, shared }: HeaderBandProps) {
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
        <p
          data-focus-branch
          className="flex min-w-0 items-center gap-1 font-mono text-meta text-text-2"
          title={project.git?.branch ? `${project.git.branch} · ${project.path}` : project.path}
        >
          {project.git?.branch && (
            <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
          )}
          <span className="truncate">{project.git?.branch ?? project.path}</span>
        </p>
      </div>
      {session && (
        <div className="hidden min-w-0 max-w-[40rem] flex-[1.6] items-center justify-end gap-3 md:flex">
          <FocusStatus session={session} />
          {session.status.kind !== 'ended' && (
            <div className="min-w-0 flex-1">
              <FocusCaption session={session} />
            </div>
          )}
        </div>
      )}
    </motion.header>
  );
}

/** The reference skin: the focus view as it is. */
export const minimalSkin: WorkspaceSkin = {
  HeaderBand: MinimalHeaderBand,
  PanelFrame: null,
  EntryTransition: null,
};
