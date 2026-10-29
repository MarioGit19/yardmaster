import type { BackgroundKind, ClaudeSession } from '@yardmaster/protocol';
import { redact } from '@yardmaster/protocol';
import { Bot, ChevronRight, CircleDashed, Radar, SquareTerminal } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useMemo } from 'react';
import { useNow } from '../anim/clock.js';
import { dur, ease, spring } from '../motion.js';
import { useRedactOn } from '../redact/reveal.js';
import type { Tone } from '../status.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import { BackgroundSpinner } from './BackgroundLine.js';
import {
  type BackgroundItem,
  backgroundItems,
  endedLabel,
  FINISHED_VISIBLE_MS,
  formatElapsed,
  groupBackground,
  KIND_LABEL,
} from './model.js';
import { backgroundOpen, useBackgroundOpen } from './open.js';

const KIND_ICON: Record<BackgroundKind, typeof Bot> = {
  shell: SquareTerminal,
  monitor: Radar,
  agent: Bot,
  other: CircleDashed,
};

const STATUS_TONE: Record<BackgroundItem['status'], Tone> = {
  running: 'work',
  done: 'ok',
  error: 'err',
  stopped: 'idle',
};

/**
 * The Claude panel's Background strip: every background shell, monitor and subagent of the
 * session, with its elapsed time while it runs. Finished ones stay for two minutes, then fold
 * into a count. Hidden while the session has never had any.
 */
export function BackgroundPanel({ session }: { session: ClaudeSession }) {
  const { background, subagents } = session;
  const items = useMemo(() => backgroundItems({ background, subagents }), [background, subagents]);
  const open = useBackgroundOpen(session.id);
  const anyRunning = items.some((item) => item.status === 'running');
  const anyRecent = items.some(
    (item) => item.status !== 'running' && Date.now() - (item.endedAt ?? 0) < FINISHED_VISIBLE_MS,
  );
  // Elapsed times tick each second while the list shows them; finished ones fold on a slower beat.
  const now = useNow(open && anyRunning ? 1_000 : anyRecent ? 15_000 : null);
  const listId = useId();
  if (items.length === 0) return null;
  const { running, recent, folded } = groupBackground(items, now);
  const finished = recent.length + folded;
  const summary = [
    running.length > 0 && `${running.length} running`,
    finished > 0 && `${finished} finished`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section
      aria-label="Background work"
      data-background-panel={session.id}
      className="shrink-0 border-line border-b"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        data-background-toggle
        onClick={() => backgroundOpen.set(session.id, !open)}
        className="flex w-full min-w-0 items-center gap-2 px-5 py-2 text-left transition-colors duration-fast hover:bg-bg-2/40 touch:min-h-11"
      >
        <ChevronRight
          aria-hidden
          strokeWidth={1.75}
          className={cx(
            'size-3.5 shrink-0 text-text-3 transition-transform duration-fast ease-out',
            open && 'rotate-90',
          )}
        />
        <span className="shrink-0 text-label text-text-1">Background</span>
        {running.length > 0 && <BackgroundSpinner />}
        <span data-background-summary className="tabular min-w-0 truncate text-meta text-text-2">
          {summary}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            key="list"
            id={listId}
            data-background-list
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
            transition={{ duration: dur.base, ease: ease.out }}
            className="flex max-h-56 flex-col gap-0.5 overflow-y-auto px-3 pb-2"
          >
            <AnimatePresence initial={false}>
              {[...running, ...recent].map((item) => (
                <motion.li
                  key={item.id}
                  layout="position"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
                  transition={spring.smooth}
                >
                  <BackgroundRow item={item} now={now} />
                </motion.li>
              ))}
            </AnimatePresence>
            {folded > 0 && (
              <li data-background-folded className="tabular px-2 py-1 text-meta text-text-3">
                {folded} finished earlier
              </li>
            )}
          </motion.ul>
        )}
      </AnimatePresence>
    </section>
  );
}

function BackgroundRow({ item, now }: { item: BackgroundItem; now: number }) {
  const redactOn = useRedactOn();
  const Icon = KIND_ICON[item.kind];
  const running = item.status === 'running';
  const label = redactOn ? redact(item.label) : item.label;
  const tail = item.tail ? (redactOn ? redact(item.tail) : item.tail) : null;
  const elapsed = formatElapsed((item.endedAt ?? now) - item.startedAt);
  const status = running ? 'Running' : endedLabel(item);
  return (
    <div
      data-background-item={item.id}
      data-status={item.status}
      className="flex min-w-0 items-start gap-2.5 rounded-control px-2 py-1.5"
    >
      <Icon
        aria-hidden
        strokeWidth={1.5}
        className={cx(
          'mt-px size-3.5 shrink-0 transition-colors duration-base',
          running ? 'text-st-work' : 'text-text-3',
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="sr-only">{KIND_LABEL[item.kind]}: </span>
          <span
            dir="auto"
            title={label}
            className={cx(
              'min-w-0 flex-1 truncate text-body-sm',
              running ? 'text-text-1' : 'text-text-2',
            )}
          >
            {label}
          </span>
          <span className="tabular shrink-0 font-mono text-meta text-text-2">{elapsed}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot
            tone={STATUS_TONE[item.status]}
            label={status}
            showLabel
            className="shrink-0 text-meta text-text-2"
          />
          <span className="truncate text-meta text-text-3">{KIND_LABEL[item.kind]}</span>
        </div>
        {tail && (
          <p
            data-background-tail
            className="line-clamp-2 break-all font-mono text-meta text-text-3"
            title={tail}
          >
            {tail}
          </p>
        )}
      </div>
    </div>
  );
}
