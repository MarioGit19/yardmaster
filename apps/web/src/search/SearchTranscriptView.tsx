import type { ChatMessage, SearchTranscriptResponse, UiAction } from '@yardmaster/protocol';
import { ArrowLeft, Play } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import { TranscriptModel } from '../claude/transcript.js';
import { useBoardClient } from '../data/index.js';
import { routes, sessionHref } from '../routes.js';
import { api } from '../settings/api.js';
import { actionErrorText } from '../terminal/stack.js';
import { buttonClass } from '../ui/Button.js';
import { Skeleton } from '../ui/Skeleton.js';
import { EmptyState } from '../views/Page.js';
import { rowForMessage } from './model.js';

const MessageList = lazy(() =>
  import('../claude/MessageList.js').then((m) => ({ default: m.MessageList })),
);

type Loaded =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'error' }
  | { status: 'ready'; transcript: SearchTranscriptResponse };

function useSearchTranscript(sessionId: string, messageId: string | undefined): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ status: 'loading' });
    api.searchTranscript(sessionId, messageId, controller.signal).then(
      (transcript) => setLoaded({ status: 'ready', transcript }),
      (err: { status?: number }) => {
        if (controller.signal.aborted) return;
        setLoaded({ status: err.status === 404 ? 'gone' : 'error' });
      },
    );
    return () => controller.abort();
  }, [sessionId, messageId]);
  return loaded;
}

const toRows = (messages: readonly ChatMessage[]) => {
  const model = new TranscriptModel();
  model.push(messages);
  return model.rows;
};

/** A session's transcript, read-only, opened at the message a search found. */
export function SearchTranscriptView({
  sessionId,
  messageId,
}: {
  sessionId: string;
  messageId?: string;
}) {
  const loaded = useSearchTranscript(sessionId, messageId);
  const transcript = loaded.status === 'ready' ? loaded.transcript : null;
  const rows = useMemo(() => toRows(transcript?.messages ?? []), [transcript]);
  const target = rowForMessage(rows, transcript?.messages ?? [], messageId);

  return (
    <div
      data-search-transcript={sessionId}
      className="absolute inset-0 mx-auto flex w-full max-w-4xl flex-col p-4 md:p-6"
    >
      <header className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 pb-3">
        <Link href={routes.search} className={buttonClass('ghost', 'sm')}>
          <ArrowLeft aria-hidden className="size-3.5" strokeWidth={1.5} />
          Search
        </Link>
        {transcript && (
          <>
            <h1 className="min-w-0 flex-1 truncate font-medium text-body text-text-1">
              {transcript.title}
            </h1>
            {transcript.projectName && (
              <span className="min-w-0 truncate text-meta text-text-2">
                {transcript.projectName}
              </span>
            )}
            <SessionLink transcript={transcript} />
          </>
        )}
      </header>
      {transcript?.clipped && (
        <p data-search-clipped className="shrink-0 pb-2 text-meta text-text-3">
          Showing the messages around this result.
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col rounded-panel border border-line bg-bg-1">
        {loaded.status === 'loading' ? (
          <TranscriptLoading />
        ) : loaded.status === 'gone' ? (
          <EmptyState title="This transcript is gone">
            Claude Code has removed the file, so only the search result remains.
          </EmptyState>
        ) : loaded.status === 'error' ? (
          <EmptyState title="Couldn’t open this transcript">Try again in a moment.</EmptyState>
        ) : (
          <Suspense fallback={<TranscriptLoading />}>
            <MessageList
              rows={rows}
              tail={null}
              cwd={transcript?.cwd ?? undefined}
              jumpTo={target}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/** Live sessions open where they run; a past one can be picked up again in its project. */
function SessionLink({ transcript }: { transcript: SearchTranscriptResponse }) {
  const client = useBoardClient();
  const { sessionId, projectId, state, title } = transcript;
  if (projectId === null) return null;
  if (state === 'live') {
    return (
      <Link href={sessionHref(projectId, sessionId)} className={buttonClass('secondary', 'sm')}>
        Open session
      </Link>
    );
  }
  const action: UiAction = { kind: 'session.resume', sessionId, projectId };
  const resume = async () => {
    const result = await client.action(action);
    if (result.ok) toast.success(`Resuming “${title}”`);
    else toast.error(actionErrorText(result.error, 'Could not resume the session'));
  };
  return (
    <button type="button" onClick={resume} className={buttonClass('secondary', 'sm')}>
      <Play aria-hidden className="size-3.5" strokeWidth={1.5} />
      Resume
    </button>
  );
}

function TranscriptLoading() {
  return (
    <div aria-busy className="flex flex-col gap-4 p-6">
      <Skeleton className="h-9 w-2/5 self-end rounded-panel" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  );
}
