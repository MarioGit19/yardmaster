import {
  type ClaudeSession,
  sessionDisplayName,
  sessionSubtitle,
  worktreeName,
} from '@yardmaster/protocol';
import { FolderGit2, GitBranch } from 'lucide-react';
import { motion } from 'motion/react';
import { useRef } from 'react';
import { useInView } from '../anim/useFrame.js';
import { BackgroundLine } from '../background/BackgroundLine.js';
import { selectApproval, useBoard } from '../data/index.js';
import { DraftMarker } from '../drafts/DraftMarker.js';
import { draftKey } from '../drafts/drafts.js';
import { POD_LAYOUT_DEPENDENCY, sharedId } from '../focus/shared.js';
import { ActorInspector } from '../layouts/ActorInspector.js';
import { actorId } from '../layouts/scene.js';
import { spring } from '../motion.js';
import { ToolChip } from '../orb/ToolChip.js';
import { plural } from '../plural.js';
import { TOKEN_ESTIMATE_HINT, tokenEstimate, totalTokens } from '../status.js';
import { useSessionStale, useSessionView } from '../statusTokens.js';
import { formatDateTime } from '../time.js';
import { StatusDot } from '../ui/StatusDot.js';
import { LiveCaption } from './LiveCaption.js';
import { isStreaming, lastLine, sessionCaption, sessionWhen, staleCaption } from './model.js';
import { type CrewView, SessionCrew } from './SessionCrew.js';

export interface SessionRowProps {
  session: ClaudeSession;
  accent: string;
  crew: CrewView;
  now: number;
  /** The branch on the pod's header: a row only repeats it when it says something else. */
  projectBranch: string | null;
  /** Compact density: one line, with the time at its end and no tokens. */
  compact?: boolean;
}

/**
 * One Claude session in a pod, DESIGN.md §4.3: crew member · status mark · what it is doing,
 * needs or produced (slides in on change) · tool chip (rows ≥ 360 px) · tokens, over the last
 * assistant line while that is still news, then the session's name, time and branch.
 */
export function SessionRow({
  session,
  accent,
  crew,
  now,
  projectBranch,
  compact = false,
}: SessionRowProps) {
  const approvalId =
    session.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const status = useSessionView(session);
  const stale = useSessionStale(session);
  const caption = stale ? staleCaption(stale) : sessionCaption(session, approval);
  // An idle row's caption already is this line.
  const line =
    compact || session.status.kind === 'idle'
      ? null
      : session.autoResumedAt
        ? 'Continuing on its own after the usage limit'
        : lastLine(session.lastAssistantText);
  const rowRef = useRef<HTMLLIElement>(null);
  const onScreen = useInView(rowRef);
  const when = sessionWhen(session, approval, now);
  const reported = session.meter?.worktree ?? null;
  const worktree = reported?.name ?? worktreeName(session.cwd);
  const sessionBranch = reported?.branch ?? session.branch;
  const branch = sessionBranch && (worktree || sessionBranch !== projectBranch);
  const tokens = totalTokens(session);
  const streaming = isStreaming(session);
  const tool = session.status.kind === 'tool' ? session.status.tool : null;
  const countdown =
    approval?.state === 'pending' && approval.expiresAt !== null
      ? { startedAt: approval.createdAt, endsAt: approval.expiresAt }
      : null;

  return (
    <li
      ref={rowRef}
      data-session={session.id}
      className="@container flex min-w-0 items-center gap-3"
    >
      <motion.span
        layoutId={sharedId.orb(session.id)}
        layoutDependency={POD_LAYOUT_DEPENDENCY}
        transition={spring.smooth}
        className="flex w-7 shrink-0 justify-center"
      >
        <ActorInspector
          projectId={session.projectId ?? ''}
          actorId={actorId.session(session.id)}
          label={`${sessionDisplayName(session)}, details`}
          trigger={
            <button
              type="button"
              aria-label={`Details for ${sessionDisplayName(session)}: ${caption.text}`}
              data-inspect={actorId.session(session.id)}
              className="pod-dim relative flex rounded-full after:absolute after:-inset-2.5"
            >
              <SessionCrew
                session={session}
                accent={accent}
                crew={crew}
                now={now}
                countdown={countdown}
              />
            </button>
          }
        />
      </motion.span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-3">
          {status.tone !== 'idle' && (
            <StatusDot tone={status.tone} label={status.label} className="self-center" />
          )}
          <LiveCaption caption={caption} className="caption flex-1 text-body-sm" />
          <DraftMarker draft={draftKey.session(session.id)} className="self-center" />
          <ToolChip tool={tool} className="hidden self-center @min-[360px]:inline-block" />
          {compact && when && (
            <time
              dateTime={new Date(when.at).toISOString()}
              title={formatDateTime(when.at)}
              className="tabular shrink-0 text-meta text-text-2"
            >
              {when.text}
            </time>
          )}
          {!compact && tokens > 0 && (
            <span
              title={`${tokens.toLocaleString('en-US')} ${plural(tokens, 'token')}. ${TOKEN_ESTIMATE_HINT}`}
              className="tabular shrink-0 font-mono text-meta text-text-2"
            >
              {tokenEstimate(tokens)}
            </span>
          )}
        </div>
        {line !== null && (
          <p
            dir="auto"
            data-shimmer={streaming || undefined}
            data-offscreen={!onScreen || undefined}
            title={line}
            className="shimmer relative truncate text-label text-text-2"
          >
            {line}
          </p>
        )}
        {!compact && (
          <p
            data-session-meta
            className="flex min-w-0 items-center gap-2 text-meta text-text-2 tabular"
          >
            <span className="min-w-0 truncate" title={sessionSubtitle(session) ?? undefined}>
              {sessionDisplayName(session)}
            </span>
            {when && (
              <time
                dateTime={new Date(when.at).toISOString()}
                title={formatDateTime(when.at)}
                className="shrink-0"
              >
                {when.text}
              </time>
            )}
            {branch && (
              <span
                title={session.branch ?? undefined}
                className="flex min-w-[min(3rem,100%)] items-center gap-1 font-mono"
              >
                <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{session.branch}</span>
              </span>
            )}
            {worktree && (
              <span
                title={`Worktree ${worktree}`}
                className="flex min-w-[min(3rem,100%)] items-center gap-1 font-mono"
              >
                <FolderGit2 aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{worktree}</span>
                <span className="sr-only"> worktree</span>
              </span>
            )}
          </p>
        )}
        <BackgroundLine session={session} className="mt-0.5" />
      </div>
    </li>
  );
}
