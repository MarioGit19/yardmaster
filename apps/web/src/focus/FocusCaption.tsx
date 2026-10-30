import type { ClaudeSession } from '@yardmaster/protocol';
import { Check, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useNow } from '../anim/clock.js';
import { selectApproval, useBoard, useBoardClient } from '../data/index.js';
import { formatUptime } from '../lanes/lane.js';
import { LiveCaption } from '../pod/LiveCaption.js';
import { sessionCaption } from '../pod/model.js';
import { useSessionView } from '../statusTokens.js';
import { actionErrorText } from '../terminal/stack.js';
import { Button } from '../ui/Button.js';
import { StatusDot } from '../ui/StatusDot.js';

/** A tool running at least this long shows its elapsed time. */
export const ELAPSED_AFTER_MS = 3_000;

/** "12s", "2m 05s": elapsed time for a long-running tool. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return formatUptime(ms);
}

/** The focused session's status token, beside its caption in the header. */
export function FocusStatus({ session }: { session: ClaudeSession }) {
  const status = useSessionView(session);
  return (
    <StatusDot
      tone={status.tone}
      label={status.label}
      showLabel
      className="shrink-0 whitespace-nowrap text-meta text-text-2"
    />
  );
}

/**
 * The focus view header's caption, DESIGN.md §4.10: the session row's live caption, larger,
 * with a progress shimmer and elapsed time while a tool runs, and inline Allow / Deny for a
 * waiting request.
 */
export function FocusCaption({ session }: { session: ClaudeSession }) {
  const approvalId =
    session.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const caption = sessionCaption(session, approval);
  const tool = session.status.kind === 'tool' ? session.currentTool : null;
  const running = tool?.status === 'running' ? tool : null;
  const now = useNow(running ? 1_000 : null);
  const elapsed = running ? now - running.startedAt : 0;
  const pending = approval?.state === 'pending' ? approval : null;

  return (
    <div data-focus-caption={caption.tone} className="flex min-w-0 items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <LiveCaption caption={caption} className="text-body" />
          {running && elapsed >= ELAPSED_AFTER_MS && (
            <span
              data-elapsed
              title="Running for"
              className="shrink-0 font-mono text-meta text-text-2 tabular"
            >
              {formatElapsed(elapsed)}
            </span>
          )}
        </div>
        {session.status.kind === 'tool' && (
          <div
            role="progressbar"
            aria-label={`${session.status.tool} running`}
            className="progress-shimmer w-full"
          />
        )}
      </div>
      {pending && <Decide approvalId={pending.id} tool={pending.tool} />}
    </div>
  );
}

function Decide({ approvalId, tool }: { approvalId: string; tool: string }) {
  const client = useBoardClient();
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'allow' | 'deny') => {
    setBusy(true);
    const result = await client.request('approval.decide', { approvalId, decision });
    setBusy(false);
    if (!result.ok) toast.error(actionErrorText(result.error, 'The decision did not go through'));
  };
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        aria-label={`Allow ${tool}`}
        onClick={() => decide('allow')}
      >
        <Check aria-hidden className="size-3.5" strokeWidth={2} />
        Allow
      </Button>
      <Button size="sm" disabled={busy} aria-label={`Deny ${tool}`} onClick={() => decide('deny')}>
        <X aria-hidden className="size-3.5" strokeWidth={2} />
        Deny
      </Button>
    </div>
  );
}
