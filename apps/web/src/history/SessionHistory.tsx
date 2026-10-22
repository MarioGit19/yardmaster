import type { SessionHistoryEntry, UiAction } from '@c-board/protocol';
import { GitBranch, Play, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useBoard, useBoardClient } from '../data/index.js';
import { ColumnHeading } from '../focus/ColumnHeading.js';
import { formatCount } from '../status.js';
import { actionErrorText } from '../terminal/stack.js';
import { formatDateTime, formatWhen } from '../time.js';
import { IconButton } from '../ui/IconButton.js';
import { Skeleton } from '../ui/Skeleton.js';
import { useSessionHistory } from './api.js';
import { historyTitle, historyTokens, pastSessions } from './model.js';

/** Rows shown before "Show more". */
export const HISTORY_SHOWN = 6;

export interface SessionHistoryProps {
  projectId: string;
  /** Sessions already on the board; they are listed above, not here. */
  knownIds: ReadonlySet<string>;
  /** Changes when a board session ends, so the list reloads. */
  refreshKey: unknown;
  /** The project's current branch; a row names its branch only when it differs. */
  branch: string | null;
}

/** Past Claude sessions of a project with resume actions (F17). */
export function SessionHistory({ projectId, knownIds, refreshKey, branch }: SessionHistoryProps) {
  const { state, retry } = useSessionHistory(projectId, refreshKey);
  const [expanded, setExpanded] = useState(false);
  const editor = useBoard(
    (s) =>
      Object.values(s.board.windows).find((w) => w.projectIds.includes(projectId))?.appName ?? null,
  );

  const sessions = state.status === 'ready' ? pastSessions(state.sessions, knownIds) : [];
  const shown = expanded ? sessions : sessions.slice(0, HISTORY_SHOWN);
  const hidden = sessions.length - shown.length;
  const now = Date.now();

  return (
    <section aria-label="Session history" data-history-list>
      <ColumnHeading meta={sessions.length || undefined}>History</ColumnHeading>
      {state.status === 'loading' ? (
        <div aria-busy className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : state.status === 'error' ? (
        <p className="text-body-sm text-text-3">
          Couldn't load past sessions.{' '}
          <button
            type="button"
            onClick={retry}
            className="text-text-2 underline underline-offset-2 hover:text-text-1"
          >
            Try again
          </button>
        </p>
      ) : sessions.length === 0 ? (
        <p className="text-body-sm text-text-2">No past sessions</p>
      ) : (
        <>
          <ul className="-mx-2 flex flex-col gap-0.5">
            {shown.map((entry) => (
              <li key={entry.id}>
                <HistoryRow entry={entry} now={now} editor={editor} branch={branch} />
              </li>
            ))}
          </ul>
          {(hidden > 0 || expanded) && sessions.length > HISTORY_SHOWN && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-1.5 rounded-control text-meta text-text-2 tabular transition-colors duration-150 hover:text-text-1"
            >
              {expanded ? 'Show fewer' : `Show ${hidden} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function HistoryRow({
  entry,
  now,
  editor,
  branch,
}: {
  entry: SessionHistoryEntry;
  now: number;
  editor: string | null;
  branch: string | null;
}) {
  const client = useBoardClient();
  const title = historyTitle(entry);
  const tokens = historyTokens(entry);
  const editorName = editor ?? 'the editor';

  const run = async (action: UiAction, done: string) => {
    const result = await client.action(action);
    if (result.ok) toast.success(done);
    else toast.error(actionErrorText(result.error, 'Could not resume the session'));
  };

  return (
    <div
      data-history={entry.id}
      className="group relative flex min-w-0 items-center gap-2 rounded-control px-2 py-1.5 transition-colors duration-150 focus-within:bg-bg-2 hover:bg-bg-2"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className="truncate text-body-sm text-text-1"
          title={
            entry.firstPrompt && entry.firstPrompt !== title
              ? `${title}\n${entry.firstPrompt}`
              : title
          }
        >
          {title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-meta text-text-2">
          <time
            className="shrink-0 tabular"
            dateTime={new Date(entry.updatedAt).toISOString()}
            title={formatDateTime(entry.updatedAt)}
          >
            {formatWhen(entry.updatedAt, now)}
          </time>
          {tokens !== null && (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0 font-mono tabular">{formatCount(tokens)} tok</span>
            </>
          )}
          {entry.gitBranch && entry.gitBranch !== branch && (
            <span className="flex min-w-0 items-center gap-1" title={entry.gitBranch}>
              <span aria-hidden>·</span>
              <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
              <span className="truncate font-mono">{entry.gitBranch}</span>
            </span>
          )}
        </span>
      </div>
      <div className="history-actions flex shrink-0 items-center">
        <IconButton
          size="sm"
          label="Resume in board"
          icon={<Play strokeWidth={1.5} />}
          tooltipSide="top"
          onClick={() =>
            run({ kind: 'session.resume', sessionId: entry.id }, `Resuming “${title}”`)
          }
        />
        <IconButton
          size="sm"
          label={`Resume in ${editorName}`}
          icon={<SquareTerminal strokeWidth={1.5} />}
          tooltipSide="top"
          data-resume-editor={entry.id}
          onClick={() =>
            run(
              { kind: 'session.resumeInEditor', projectId: entry.projectId, sessionId: entry.id },
              `Opened a terminal in ${editorName}`,
            )
          }
        />
      </div>
    </div>
  );
}
