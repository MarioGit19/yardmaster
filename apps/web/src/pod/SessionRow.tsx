import { type ClaudeSession, sessionDisplayName } from '@yardmaster/protocol';
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
import { formatCount, totalTokens } from '../status.js';
import { formatStarted } from '../time.js';
import { LiveCaption } from './LiveCaption.js';
import { isStreaming, lastLine, sessionCaption } from './model.js';
import { type CrewView, SessionCrew } from './SessionCrew.js';

export interface SessionRowProps {
  session: ClaudeSession;
  accent: string;
  crew: CrewView;
  now: number;
}

/**
 * One Claude session in a pod, DESIGN.md §4.3: crew member · live caption (slides in on change) ·
 * tool chip (rows ≥ 360 px) · tokens, over the last assistant line, which shimmers while the
 * session streams.
 */
export function SessionRow({ session, accent, crew, now }: SessionRowProps) {
  const approvalId =
    session.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const caption = sessionCaption(session, approval);
  const line = lastLine(session.lastAssistantText);
  const lineRef = useRef<HTMLParagraphElement>(null);
  const lineOnScreen = useInView(lineRef);
  const title = session.title?.trim() || null;
  // Untitled sessions with no reply yet would read the same: their start time and short id
  // (what `claude --resume` takes) tell them apart.
  const fallback =
    title && title !== caption.text
      ? title
      : `Started ${formatStarted(session.startedAt, Date.now())} · ${session.id.slice(0, 8)}`;
  const tokens = totalTokens(session);
  const streaming = isStreaming(session);
  const tool = session.status.kind === 'tool' ? session.status.tool : null;
  const countdown =
    approval?.state === 'pending' && approval.expiresAt !== null
      ? { startedAt: approval.createdAt, endsAt: approval.expiresAt }
      : null;

  return (
    <li data-session={session.id} className="@container flex min-w-0 items-center gap-3">
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
          <LiveCaption caption={caption} className="caption flex-1 text-body-sm" />
          <DraftMarker draft={draftKey.session(session.id)} className="self-center" />
          <ToolChip tool={tool} className="hidden self-center @min-[360px]:inline-block" />
          {tokens > 0 && (
            <span
              title={`${tokens.toLocaleString('en-US')} ${plural(tokens, 'token')}`}
              className="tabular shrink-0 font-mono text-meta text-text-2"
            >
              {formatCount(tokens)} tok
            </span>
          )}
        </div>
        <p
          ref={lineRef}
          dir="auto"
          data-shimmer={(streaming && line !== null) || undefined}
          data-offscreen={!lineOnScreen || undefined}
          title={line ?? undefined}
          className="shimmer relative truncate text-label text-text-2"
        >
          {line ?? fallback}
        </p>
        <BackgroundLine session={session} className="mt-0.5" />
      </div>
    </li>
  );
}
