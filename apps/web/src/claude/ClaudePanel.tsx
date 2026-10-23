import type { ClaudeSession } from '@c-board/protocol';
import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { MORPH_SETTLE_MS } from '../focus/shared.js';
import { dur, ease } from '../motion.js';
import { sessionCaption } from '../pod/model.js';
import { formatCount, sessionStatusView, totalTokens } from '../status.js';
import { Chip } from '../ui/Chip.js';
import { cx } from '../ui/cx.js';
import { Skeleton } from '../ui/Skeleton.js';
import { StatusDot } from '../ui/StatusDot.js';
import { EmptyState } from '../views/Page.js';
import { SessionComposer } from './Composer.js';
import { ChatDensityContext, chatColumn, useCompactChat } from './density.js';
import { OriginBadge } from './OriginBadge.js';
import { streamingTail } from './transcript.js';
import { useTranscript } from './useTranscript.js';

// Markdown, highlighting and virtualization load with the first conversation, not the app.
const MessageList = lazy(() =>
  import('./MessageList.js').then((m) => ({ default: m.MessageList })),
);

/** Statuses during which Claude may still be writing the last text block. */
const WRITING = new Set<ClaudeSession['status']['kind']>(['working', 'tool']);

/**
 * The focus view's center column: one session's conversation (DESIGN.md §4.6). `compact` is the
 * same chat inside a Claude terminal's pane, whose tab and header already name the session.
 */
export function ClaudePanel({
  session,
  defer = false,
  compact = false,
}: {
  session: ClaudeSession;
  /** Hold the transcript back until the pod-to-focus morph has settled. */
  defer?: boolean;
  compact?: boolean;
}) {
  const [settled, setSettled] = useState(!defer);
  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => setSettled(true), MORPH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settled]);
  // The replay of a long transcript is hundreds of socket messages: keep them out of the morph.
  const { rows, loaded } = useTranscript(session.id, settled);
  const status = sessionStatusView(session.status);
  const writing = WRITING.has(session.status.kind);
  // Board sessions stream into `draft`, cleared as the block lands in the transcript.
  const tail =
    session.origin === 'board'
      ? writing && session.draft
        ? session.draft
        : null
      : streamingTail(
          rows,
          { text: session.lastAssistantText, at: session.lastAssistantAt ?? null },
          writing,
        );
  // Terminal sessions don't stream text: until Claude writes, the transcript ends on what it does.
  const caption =
    session.origin === 'terminal' && writing && tail === null ? sessionCaption(session) : null;
  const column = chatColumn(compact);

  return (
    <ChatDensityContext value={compact ? 'compact' : 'regular'}>
      <div
        className="claude-panel flex h-full min-h-0 flex-col"
        data-session-panel={session.id}
        data-density={compact ? 'compact' : undefined}
      >
        {!compact && (
          <header className="flex min-w-0 shrink-0 items-center gap-3 border-line border-b px-5 pt-5 pb-3">
            <h2
              className="min-w-0 flex-1 truncate font-medium text-body text-text-1 leading-7"
              title={session.title ?? undefined}
            >
              {session.title ?? 'Claude session'}
            </h2>
            <OriginBadge origin={session.origin} compact="narrow" />
            <StatusDot
              tone={status.tone}
              label={status.label}
              showLabel
              className="shrink-0 text-meta text-text-2"
            />
            {session.model && (
              <span className="hidden min-w-0 max-w-40 xl:flex">
                <Chip mono title={session.model}>
                  {session.model.replace(/^claude-/, '')}
                </Chip>
              </span>
            )}
            <span className="tabular shrink-0 font-mono text-meta text-text-2">
              {formatCount(totalTokens(session))} tok
            </span>
          </header>
        )}
        {/* The skeleton cross-fades into the transcript, and one session's into the next's; the old
          one leaves faster than the new one arrives. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              key={loaded ? session.id : 'skeleton'}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
              transition={{ duration: dur.base, ease: ease.out }}
              className="flex min-h-0 flex-1 flex-col"
            >
              {!loaded ? (
                <TranscriptSkeleton />
              ) : rows.length === 0 && tail === null ? (
                <div className={cx('min-h-0 flex-1', column.gutter)}>
                  <EmptyState title="No messages yet">
                    {session.origin === 'board'
                      ? 'Your first message and Claude’s reply show up here.'
                      : 'The conversation shows up here as soon as Claude writes to its transcript.'}
                  </EmptyState>
                </div>
              ) : (
                <Suspense fallback={<TranscriptSkeleton />}>
                  <MessageList
                    rows={rows}
                    tail={tail}
                    caption={caption}
                    cwd={session.cwd ?? undefined}
                  />
                </Suspense>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <SessionComposer session={session} />
      </div>
    </ChatDensityContext>
  );
}

function TranscriptSkeleton() {
  const column = chatColumn(useCompactChat());
  return (
    <div
      aria-busy
      className={cx(
        'flex min-h-0 w-full flex-1 flex-col gap-4 pt-5',
        column.measure,
        column.gutter,
      )}
    >
      <Skeleton className="h-9 w-2/5 self-end rounded-panel" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-8 w-full rounded-control" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}
