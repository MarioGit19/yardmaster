import type { ClaudeSession } from '@c-board/protocol';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { Link } from 'wouter';
import { selectApproval, selectProject, useBoard, useBoardList } from '../data/index.js';
import { dur, ease, spring } from '../motion.js';
import { sessionCaption } from '../pod/model.js';
import { useMediaQuery, usePreference } from '../prefs.js';
import { sessionHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { NARROW_QUERY } from '../shell/prefs.js';
import { isTypingTarget } from '../shell/railNav.js';
import { IconButton } from '../ui/IconButton.js';
import { StatusDot } from '../ui/StatusDot.js';
import { attentionOpen, selectWaitingSessions } from './attention.js';

const close = () => attentionOpen.set('closed');

/**
 * The right sheet (a bottom sheet on narrow screens) listing everything that waits for the user,
 * DESIGN.md §4.5. 8.4 adds the approval cards and their keyboard actions.
 */
export function AttentionCenter() {
  const open = usePreference(attentionOpen) === 'open';
  const narrow = useMediaQuery(NARROW_QUERY);
  const offscreen = narrow ? { y: '100%' } : { x: '100%' };
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="attention"
          aria-labelledby="attention-title"
          initial={{ ...offscreen, opacity: 0 }}
          animate={{ x: 0, y: 0, opacity: 1, transition: spring.smooth }}
          exit={{ ...offscreen, opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
          className={
            narrow
              ? 'fixed inset-x-0 bottom-0 z-40 flex max-h-[70dvh] flex-col rounded-t-modal border-line border-t bg-bg-1 shadow-raised'
              : 'fixed top-12 right-0 bottom-0 z-40 flex w-96 flex-col border-line border-l bg-bg-1 shadow-raised'
          }
        >
          <SheetBody />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function SheetBody() {
  const waiting = useBoardList(selectWaitingSessions);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    heading.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event.target)) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-line border-b pr-2 pl-5">
        <h2
          id="attention-title"
          ref={heading}
          tabIndex={-1}
          className="flex-1 text-body text-text-1 outline-none"
        >
          Needs you
          <span className="ml-2 text-text-3 tabular-nums">{waiting.length}</span>
        </h2>
        <IconButton
          label="Close"
          shortcut="Escape"
          size="sm"
          tooltipSide="left"
          onClick={close}
          icon={<X className="size-4" strokeWidth={1.5} />}
        />
      </header>
      {waiting.length === 0 ? (
        <p className="px-5 py-8 text-center text-body-sm text-text-3">
          Nothing is waiting for you.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 overflow-y-auto p-2">
          {waiting.map((session) => (
            <WaitingItem key={session.id} session={session} />
          ))}
        </ul>
      )}
    </>
  );
}

function WaitingItem({ session }: { session: ClaudeSession }) {
  const project = useBoard(selectProject(session.projectId ?? ''));
  const approvalId =
    session.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const caption = sessionCaption(session, approval);
  const href = project ? sessionHref(project.id, session.id) : null;
  const body = (
    <>
      {project && <ProjectAvatar project={project} />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body-sm text-text-1">
          {project?.name ?? 'No project'}
          {session.title && <span className="text-text-3"> · {session.title}</span>}
        </span>
        <StatusDot tone="wait" label={caption.text} showLabel className="text-label text-st-wait" />
      </span>
    </>
  );
  const row = 'flex items-center gap-3 rounded-control px-3 py-2';
  return (
    <li data-waiting={session.id}>
      {href ? (
        <Link href={href} onClick={close} className={`${row} hover:bg-bg-2`}>
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}
