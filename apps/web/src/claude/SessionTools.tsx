import {
  type ClaudeSession,
  isArchivedSession,
  sessionDisplayName,
  sessionWorktree,
  type UiAction,
} from '@yardmaster/protocol';
import { Archive, ArchiveRestore, FileDiff, Pencil } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { useBoard, useBoardClient } from '../data/index.js';
import { reviewHref } from '../routes.js';
import { actionErrorText } from '../terminal/stack.js';
import { Button } from '../ui/Button.js';
import { IconButton } from '../ui/IconButton.js';
import { Popover } from '../ui/Popover.js';

/** Archives a finished session, with a toast that puts it back. */
export function useArchiveSession() {
  const client = useBoardClient();
  const send = async (sessionId: string, archived: boolean) => {
    const action: UiAction = { kind: 'session.archive', sessionId, archived };
    const result = await client.action(action);
    if (!result.ok) toast.error(actionErrorText(result.error, 'Could not update the session'));
    return result.ok;
  };
  return {
    unarchive: (sessionId: string) => send(sessionId, false),
    archive: async (session: Pick<ClaudeSession, 'id'> & { name: string }) => {
      if (!(await send(session.id, true))) return;
      toast.success(`Archived “${session.name}”`, {
        description: 'It stays in History.',
        action: { label: 'Undo', onClick: () => void send(session.id, false) },
      });
    },
  };
}

/** Archives one finished session, from wherever it is listed. */
export function ArchiveButton({
  session,
  className,
  labelled = false,
}: {
  session: ClaudeSession;
  className?: string;
  /** Phones: the action in words. */
  labelled?: boolean;
}) {
  const { archive } = useArchiveSession();
  const name = sessionDisplayName(session);
  if (labelled) {
    return (
      <Button
        variant="ghost"
        size="sm"
        data-archive-session={session.id}
        onClick={() => void archive({ id: session.id, name })}
      >
        <Archive aria-hidden className="size-3.5" strokeWidth={1.5} />
        Archive
      </Button>
    );
  }
  return (
    <IconButton
      label={`Archive ${name}`}
      size="sm"
      data-archive-session={session.id}
      onClick={() => void archive({ id: session.id, name })}
      icon={<Archive aria-hidden className="size-3.5" strokeWidth={1.5} />}
      {...(className ? { className } : {})}
    />
  );
}

/** Puts an archived session back on the board's lists. */
export function UnarchiveButton({
  sessionId,
  labelled = false,
}: {
  sessionId: string;
  /** Phones: the action in words. */
  labelled?: boolean;
}) {
  const { unarchive } = useArchiveSession();
  if (labelled) {
    return (
      <Button
        variant="ghost"
        size="sm"
        data-unarchive-session={sessionId}
        onClick={() => void unarchive(sessionId)}
      >
        <ArchiveRestore aria-hidden className="size-3.5" strokeWidth={1.5} />
        Back to the list
      </Button>
    );
  }
  return (
    <IconButton
      size="sm"
      label="Back to the session list"
      icon={<ArchiveRestore strokeWidth={1.5} />}
      tooltipSide="top"
      data-unarchive-session={sessionId}
      onClick={() => void unarchive(sessionId)}
    />
  );
}

export function RenameSession({
  session,
  labelled = false,
}: {
  session: ClaudeSession;
  /** Phones: the action in words. */
  labelled?: boolean;
}) {
  const client = useBoardClient();
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const terminal = session.origin === 'terminal';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const title = input.current?.value.trim() ?? '';
    // Only a board-side name can be cleared: Claude Code's own has no way back.
    if (!title && !terminal) return;
    const result = await client.action({ kind: 'session.rename', sessionId: session.id, title });
    if (result.ok) setOpen(false);
    else toast.error(actionErrorText(result.error, 'Could not rename the session'));
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Rename session"
      className="flex w-72 max-w-[calc(100vw-32px)] flex-col gap-2"
      data-rename-popover
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }}
      trigger={
        labelled ? (
          <Button variant="ghost" size="sm" data-rename-session>
            <Pencil aria-hidden className="size-3.5" strokeWidth={1.5} />
            Rename
          </Button>
        ) : (
          <IconButton
            label="Rename session"
            size="sm"
            data-rename-session
            icon={<Pencil aria-hidden className="size-3.5" strokeWidth={1.5} />}
          />
        )
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-2">
        <input
          ref={input}
          aria-label="Session name"
          defaultValue={session.boardTitle ?? sessionDisplayName(session)}
          maxLength={512}
          className="h-8 min-w-0 rounded-control border border-line bg-bg-1 px-2 text-body-sm text-text-1 outline-none focus-visible:shadow-[var(--focus-ring)] touch:h-11"
        />
        {terminal && (
          <p data-rename-hint className="text-meta text-text-2">
            Saved on this board only. Claude Code keeps its own name for this session.
          </p>
        )}
        <Button type="submit" size="sm" className="self-end">
          Rename
        </Button>
      </form>
    </Popover>
  );
}

/** Rename, and Archive once the session has finished. */
/** Opens the review of the folder this session works in: its worktree, or the project's. */
function ReviewSessionButton({ session }: { session: ClaudeSession }) {
  const [, navigate] = useLocation();
  const { projectId } = session;
  const git = useBoard((s) => (projectId ? s.board.projects[projectId]?.git : null));
  if (!projectId || !git || git.statusSkipped) return null;
  return (
    <IconButton
      label="Review changes"
      size="sm"
      data-session-review
      icon={<FileDiff className="size-3.5" strokeWidth={1.5} />}
      onClick={() => navigate(reviewHref(projectId, sessionWorktree(session, git)?.id))}
    />
  );
}

export function SessionTools({
  session,
  labelled = false,
}: {
  session: ClaudeSession;
  labelled?: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 self-center">
      <RenameSession session={session} labelled={labelled} />
      {/* Phones reach it from the project hub: their chat strip has no room for the words. */}
      {!labelled && <ReviewSessionButton session={session} />}
      {session.status.kind === 'ended' && !isArchivedSession(session) && (
        <ArchiveButton session={session} labelled={labelled} />
      )}
    </span>
  );
}
