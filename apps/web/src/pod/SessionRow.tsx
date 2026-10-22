import type { ClaudeSession } from '@c-board/protocol';
import { motion } from 'motion/react';
import { selectApproval, useBoard } from '../data/index.js';
import { POD_LAYOUT_DEPENDENCY, sharedId } from '../focus/shared.js';
import { spring } from '../motion.js';
import { ClaudeOrb } from '../orb/ClaudeOrb.js';
import { orbStateFor } from '../orb/model.js';
import { formatCount, totalTokens } from '../status.js';
import { formatStarted } from '../time.js';
import { LiveCaption } from './LiveCaption.js';
import { isStreaming, lastLine, sessionCaption } from './model.js';

/**
 * One Claude session in a pod, DESIGN.md §4.3: orb · live caption (slides in on change) ·
 * tokens, over the last assistant line, which shimmers while the session streams.
 */
export function SessionRow({ session, accent }: { session: ClaudeSession; accent: string }) {
  const approvalId =
    session.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const caption = sessionCaption(session, approval);
  const line = lastLine(session.lastAssistantText);
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
  const subagents = session.subagents.filter((a) => a.status === 'running').length;
  const countdown =
    approval?.state === 'pending' && approval.expiresAt !== null
      ? { startedAt: approval.createdAt, endsAt: approval.expiresAt }
      : null;

  return (
    <li data-session={session.id} className="flex min-w-0 items-center gap-3">
      <motion.span
        layoutId={sharedId.orb(session.id)}
        layoutDependency={POD_LAYOUT_DEPENDENCY}
        transition={spring.smooth}
        className="flex shrink-0"
      >
        <span className="pod-dim flex">
          <ClaudeOrb
            state={orbStateFor(session.status)}
            size={28}
            accent={accent}
            tool={tool}
            subagents={subagents}
            countdown={countdown}
            showToolLabel={false}
          />
        </span>
      </motion.span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-3">
          <LiveCaption caption={caption} className="caption flex-1 text-body-sm" />
          {tokens > 0 && (
            <span
              title={`${tokens.toLocaleString('en-US')} tokens`}
              className="tabular shrink-0 font-mono text-meta text-text-2"
            >
              {formatCount(tokens)} tok
            </span>
          )}
        </div>
        <p
          dir="auto"
          data-shimmer={(streaming && line !== null) || undefined}
          title={line ?? undefined}
          className="shimmer relative truncate text-label text-text-2"
        >
          {line ?? fallback}
        </p>
      </div>
    </li>
  );
}
