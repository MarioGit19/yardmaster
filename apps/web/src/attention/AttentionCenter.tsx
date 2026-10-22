import { type ClaudeSession, toolInputDetail } from '@c-board/protocol';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { Link } from 'wouter';
import { selectApproval, selectProject, useBoard, useBoardList } from '../data/index.js';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
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
  // Reduced cross-fades in place; Off mounts the sheet already at rest.
  const level = useMotionLevel();
  const still = level !== 'full';
  const offscreen = still ? 'none' : narrow ? 'translateY(100%)' : 'translateX(100%)';
  return (
    <AnimatePresence>
      {open && (
        // The scrim sets the sheet apart from the pods it covers; a click on it closes the sheet.
        <motion.div
          key="attention-scrim"
          aria-hidden
          data-attention-scrim
          onClick={close}
          initial={level === 'off' ? false : { opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: dur.base, ease: ease.out } }}
          exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
          className="fixed inset-x-0 top-12 bottom-0 z-40 bg-bg-0/50"
        />
      )}
      {open && (
        <motion.aside
          key="attention"
          aria-labelledby="attention-title"
          initial={level === 'off' ? false : { transform: offscreen, opacity: 0 }}
          animate={{ transform: 'none', opacity: 1, transition: spring.smooth }}
          exit={{
            transform: offscreen,
            opacity: 0,
            transition: { duration: dur.fast, ease: ease.out },
          }}
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
          <span className="ml-2 text-text-2 tabular-nums">{waiting.length}</span>
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
        <p className="px-5 py-8 text-center text-body-sm text-text-2">
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
  // The exact payload (the command, the file) until 8.4's full approval cards.
  const raw = approval ? toolInputDetail(approval.input)?.trim() || null : null;
  const detail =
    raw && project && raw.startsWith(`${project.path}/`) ? raw.slice(project.path.length + 1) : raw;
  const title = session.title?.trim() || null;
  const href = project ? sessionHref(project.id, session.id) : null;
  const body = (
    <>
      {project && <ProjectAvatar project={project} />}
      <span className="flex min-w-0 flex-1 flex-col">
        {/* Name and title shrink in proportion, so a long project name can't hide the title. */}
        <span className="flex min-w-0 text-body-sm">
          <span className="min-w-0 truncate text-text-1" title={project?.name}>
            {project?.name ?? 'No project'}
          </span>
          {title && (
            <span className="min-w-0 truncate text-text-2" title={title}>
              <span aria-hidden>&nbsp;·&nbsp;</span>
              {title}
            </span>
          )}
        </span>
        <StatusDot
          tone="wait"
          label={approval ? `Wants to run ${approval.tool}` : caption.text}
          showLabel
          className="text-label text-st-wait-ink"
        />
        {detail && (
          <code
            title={detail}
            className="mt-1.5 line-clamp-2 break-all rounded-chip bg-bg-2 px-2 py-1 font-mono text-label text-text-1"
          >
            {detail}
          </code>
        )}
      </span>
    </>
  );
  const row = 'flex items-start gap-3 rounded-control px-3 py-2';
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
