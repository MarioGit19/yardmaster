import type { ClaudeSession } from '@c-board/protocol';
import { selectApproval, useBoard } from '../data/index.js';
import { ClaudeOrb } from '../orb/ClaudeOrb.js';
import { orbStateFor } from '../orb/model.js';
import { formatCount, totalTokens } from '../status.js';
import { cx } from '../ui/cx.js';
import { type CaptionTone, isStreaming, lastLine, sessionCaption } from './model.js';
import { Typewriter } from './Typewriter.js';

const CAPTION_COLOR: Record<CaptionTone, string> = {
  active: 'text-text-1',
  wait: 'text-st-wait',
  err: 'text-st-err',
  rest: 'text-text-3',
};

/**
 * One Claude session in a pod, DESIGN.md §4.3: orb · status caption (typed in on change) ·
 * tokens, over the last assistant line, which shimmers while the session streams.
 */
export function SessionRow({ session, accent }: { session: ClaudeSession; accent: string }) {
  const approvalId =
    session.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const caption = sessionCaption(session, approval);
  const line = lastLine(session.lastAssistantText);
  const title = session.title?.trim() || null;
  const fallback = title && title !== caption.text ? title : 'No reply yet';
  const streaming = isStreaming(session);
  const tool = session.status.kind === 'tool' ? session.status.tool : null;
  const subagents = session.subagents.filter((a) => a.status === 'running').length;
  const countdown =
    approval?.state === 'pending' && approval.expiresAt !== null
      ? { startedAt: approval.createdAt, endsAt: approval.expiresAt }
      : null;

  return (
    <li data-session={session.id} className="flex min-w-0 items-center gap-3">
      <ClaudeOrb
        state={orbStateFor(session.status)}
        size={28}
        accent={accent}
        tool={tool}
        subagents={subagents}
        countdown={countdown}
        showToolLabel={false}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-3">
          <p
            title={caption.text}
            className={cx(
              'caption min-w-0 flex-1 truncate text-body-sm',
              CAPTION_COLOR[caption.tone],
            )}
          >
            {caption.glyph && (
              <span aria-hidden className="mr-1.5 inline-block w-3 text-center font-mono">
                {caption.glyph}
              </span>
            )}
            <Typewriter key={caption.text} text={caption.text} />
          </p>
          <span
            title={`${totalTokens(session).toLocaleString('en-US')} tokens`}
            className="tabular shrink-0 font-mono text-meta text-text-3"
          >
            {formatCount(totalTokens(session))} tok
          </span>
        </div>
        <p
          data-shimmer={(streaming && line !== null) || undefined}
          title={line ?? undefined}
          className="shimmer relative truncate text-label text-text-3"
        >
          {line ?? fallback}
        </p>
      </div>
    </li>
  );
}
