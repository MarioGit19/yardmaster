import type { ClaudeSession, Project } from '@yardmaster/protocol';
import { GitBranch, Sparkles, SquareTerminal } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { selectApproval, useBoard } from '../data/index.js';
import { POD_LAYOUT_DEPENDENCY, sharedId } from '../focus/shared.js';
import { spring } from '../motion.js';
import { countOf } from '../plural.js';
import { projectHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { type Tone, toneLabel } from '../status.js';
import { useSessionStale } from '../statusTokens.js';
import { formatDateTime, formatWhen } from '../time.js';
import { StatusDot } from '../ui/StatusDot.js';
import { LiveCaption } from './LiveCaption.js';
import { sessionCaption, staleCaption } from './model.js';

/** How many sessions and terminals a project has running, drawn only when there are some. */
export function PodCounts({ sessions, terminals }: { sessions: number; terminals: number }) {
  if (sessions + terminals === 0) return null;
  return (
    <span
      data-pod-counts=""
      title={[countOf(sessions, 'session'), countOf(terminals, 'terminal')].join(', ')}
      className="flex shrink-0 items-center gap-2 font-mono text-meta text-text-2 tabular"
    >
      {sessions > 0 && <Count icon={<Sparkles />} value={sessions} unit="session" />}
      {terminals > 0 && <Count icon={<SquareTerminal />} value={terminals} unit="terminal" />}
    </span>
  );
}

function Count({ icon, value, unit }: { icon: ReactNode; value: number; unit: string }) {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden className="flex [&_svg]:size-3 [&_svg]:stroke-[1.75]">
        {icon}
      </span>
      {value}
      <span className="sr-only"> {unit}</span>
    </span>
  );
}

/** The project's last activity, relative, with the absolute time in the tooltip. */
export function PodWhen({
  at,
  now,
  className,
}: {
  at: number | null;
  now: number;
  className?: string;
}) {
  if (at === null) return null;
  return (
    <time dateTime={new Date(at).toISOString()} title={formatDateTime(at)} className={className}>
      {formatWhen(at, now)}
    </time>
  );
}

/** What the project's top session is doing, needs or produced. */
function PodLead({ session }: { session: ClaudeSession }) {
  const approvalId =
    session.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const stale = useSessionStale(session);
  const caption = stale ? staleCaption(stale) : sessionCaption(session, approval);
  return <LiveCaption caption={caption} className="caption text-body-sm" />;
}

export interface PodLineProps {
  project: Project;
  tone: Tone;
  /** The most urgent live session, when the line has room to say what it's doing. */
  lead: ClaudeSession | null;
  sessions: number;
  terminals: number;
  lastActivity: number | null;
  now: number;
  /** Replaces the branch while the project's editor window opens. */
  opening: ReactNode;
}

/**
 * A project folded to one line (DESIGN.md §4.3): status, name, branch, last activity and counts,
 * with the lead session's caption in List. Narrow lines give up the caption, then the branch.
 */
export function PodLine({
  project,
  tone,
  lead,
  sessions,
  terminals,
  lastActivity,
  now,
  opening,
}: PodLineProps) {
  const branch = project.git?.branch ?? project.git?.head?.slice(0, 7) ?? null;
  return (
    <motion.header
      layoutId={sharedId.header(project.id)}
      layoutDependency={POD_LAYOUT_DEPENDENCY}
      transition={spring.smooth}
      className="flex min-w-0 items-center gap-2.5"
    >
      <span className="pod-dim flex shrink-0">
        <ProjectAvatar project={project} size="sm" />
      </span>
      <Link
        href={projectHref(project.id)}
        title={project.name}
        className="pod-line-name min-w-0 truncate font-medium text-body-sm text-text-1 after:absolute after:inset-0 after:rounded-panel focus-visible:shadow-none focus-visible:after:shadow-focus"
      >
        {project.name}
      </Link>
      <span className="pod-line-mark flex shrink-0">
        {tone !== 'idle' && <StatusDot tone={tone} label={toneLabel(tone)} />}
      </span>
      {opening ??
        (branch && (
          <span
            title={branch}
            className="pod-line-branch flex min-w-0 items-center gap-1 font-mono text-meta text-text-2"
          >
            <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{branch}</span>
          </span>
        ))}
      <span className="pod-line-lead min-w-0 flex-1">{lead && <PodLead session={lead} />}</span>
      <PodWhen
        at={lastActivity}
        now={now}
        className="pod-line-when shrink-0 text-meta text-text-2 tabular"
      />
      <PodCounts sessions={sessions} terminals={terminals} />
    </motion.header>
  );
}
