import './grid-skin.css';
import { ArrowLeft, GitBranch } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import {
  selectSessionsByProject,
  selectTerminalsByProject,
  useBoardList,
  useMaxActivityStep,
} from '../../../data/index.js';
import { DecryptedText } from '../../../fx/DecryptedText.js';
import { podSessions } from '../../../pod/model.js';
import { routes } from '../../../routes.js';
import { ProjectAvatar } from '../../../shell/ProjectAvatar.js';
import { projectTone, sessionStatusView, toneLabel } from '../../../status.js';
import { buttonClass } from '../../../ui/Button.js';
import { Chip } from '../../../ui/Chip.js';
import { StatusDot } from '../../../ui/StatusDot.js';
import { Tooltip } from '../../../ui/Tooltip.js';
import { FocusCaption } from '../../FocusCaption.js';
import type {
  EntryTransitionProps,
  HeaderBandProps,
  PanelFrameProps,
  WorkspaceSkin,
} from '../types.js';

/**
 * Grid's header band: the cockpit's title screen carried into the workspace. Back, the project's
 * name (resolving out of the scramble as it did in the cockpit), its state, the focused session's
 * live caption and the branch, on a holo strip.
 */
function GridHeaderBand({ project, session, headingRef }: HeaderBandProps) {
  const sessions = useBoardList(selectSessionsByProject(project.id));
  const terminals = useBoardList(selectTerminalsByProject(project.id));
  const live = session !== null && session.status.kind !== 'ended';
  // The focused session's state, or the project's as its cockpit showed it.
  const tone = live
    ? sessionStatusView(session.status).tone
    : projectTone(podSessions(sessions), terminals);
  return (
    <header data-grid-band className="gs-band">
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
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h1
          ref={headingRef}
          tabIndex={-1}
          title={project.name}
          className="gs-band-name truncate outline-none focus-visible:shadow-none"
        >
          <DecryptedText text={project.name} resolveOnMount />
        </h1>
        <div className="flex min-w-0 items-center gap-3">
          <StatusDot
            tone={tone}
            label={live ? sessionStatusView(session.status).label : toneLabel(tone)}
            showLabel
            className="gs-band-state shrink-0"
          />
          <p className="min-w-0 truncate font-mono text-meta text-text-3" title={project.path}>
            {project.path}
          </p>
        </div>
      </div>
      {session && live && (
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
    </header>
  );
}

/** Bars of the title bar's activity meter: one per busy step. */
const METER_BARS = 3;

/**
 * A holo screen (§10.8): a neon edge with corner brackets, a Geist Mono caps title bar, and a soft
 * outer glow whose strength follows the panel's activity. The step changes a few times a second at
 * most (`useMaxActivityStep`), and CSS carries the glow between steps, so nothing renders per
 * frame. A panel that waits or failed takes that status color for its edge.
 */
function GridPanelFrame({ title, activity, tone, children }: PanelFrameProps) {
  const step = useMaxActivityStep(activity);
  return (
    <div className="gs-frame" data-grid-panel={title} data-level={step} data-tone={tone}>
      <span aria-hidden className="gs-glow" />
      <div aria-hidden className="gs-titlebar">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="gs-meter">
          {Array.from({ length: METER_BARS }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed bars
            <span key={i} data-lit={i < step || undefined} />
          ))}
        </span>
      </div>
      <div className="gs-frame-body">{children}</div>
    </div>
  );
}

/**
 * The cockpit's phase-in, continued (§10.8): a scanline sweeps down the card while its screens
 * settle into the workspace columns out of a brief chromatic split (`--dur-phase`). Full only; the
 * view cross-fades at Reduced and appears at Off.
 */
function GridEntry(_props: EntryTransitionProps) {
  const [done, setDone] = useState(false);
  if (done) return null;
  return (
    <div aria-hidden data-grid-entry className="gs-entry">
      <span className="gs-entry-scan" onAnimationEnd={() => setDone(true)} />
    </div>
  );
}

const gridSkin: WorkspaceSkin = {
  HeaderBand: GridHeaderBand,
  PanelFrame: GridPanelFrame,
  EntryTransition: GridEntry,
};

export default gridSkin;
