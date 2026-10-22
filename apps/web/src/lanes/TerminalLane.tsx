import type { Terminal } from '@c-board/protocol';
import { ChevronRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { useNow } from '../anim/clock.js';
import {
  activityKey,
  isCrashExit,
  selectPortsByTerminal,
  useActivityStep,
  useBoardList,
  useBoardShallow,
} from '../data/index.js';
import { dur, ease, slide, spring, useMotionLevel } from '../motion.js';
import { cx } from '../ui/cx.js';
import { ExitBadge } from '../ui/ExitBadge.js';
import { formatUptime, laneView, selectLaneExecution, terminalName, uptimePeriod } from './lane.js';
import { PortChip } from './PortChip.js';
import { Sparkline } from './Sparkline.js';
import { TerminalPeek } from './TerminalPeek.js';
import { useErrorLine } from './useErrorLine.js';

/** Hovering across lanes shouldn't flash a peek for every lane the pointer crosses. */
const PEEK_DELAY_MS = 140;
const PEEK_IN_S = 0.18;

export interface TerminalLaneProps {
  terminal: Terminal;
  /** The project accent, e.g. `var(--accent-3)`: sparkline and comet tint. */
  accent: string;
}

/**
 * One terminal in a pod, DESIGN.md §4.3: name · command · throughput · port · uptime or exit.
 * Columns are fixed tracks (`.lane-row`), so lanes line up across pods. Hover or focus opens
 * a live peek of the last six lines; clicking the name pins it.
 */
export function TerminalLane({ terminal, accent }: TerminalLaneProps) {
  const execution = useBoardShallow(selectLaneExecution(terminal));
  const ports = useBoardList(selectPortsByTerminal(terminal.id));
  const view = laneView(terminal, execution);
  // Pulse speed and comet follow the store's activity level for the terminal (§4.10).
  const level = useActivityStep(activityKey.terminal(terminal.id));
  const crashed = isCrashExit(view.exit?.code);
  const errorLine = useErrorLine(crashed ? (view.exit?.key ?? null) : null);

  const now = useNow(view.startedAt === null ? null : uptimePeriod(Date.now() - view.startedAt));
  const uptime = view.startedAt === null ? null : formatUptime(now - view.startedAt);

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = pinned || hovered || focused;
  const peekId = useId();

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const hover = (next: boolean) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (!next) setHovered(false);
    else hoverTimer.current = setTimeout(() => setHovered(true), PEEK_DELAY_MS);
  };

  const streaming = level > 0;
  const [port, ...morePorts] = ports;

  return (
    <li
      data-lane={terminal.id}
      data-streaming={streaming || undefined}
      data-level={streaming ? level : undefined}
      data-crashed={crashed || undefined}
      data-open={open || undefined}
      className="relative"
      style={
        { '--lane-tint': view.tone === 'err' ? 'var(--st-err)' : accent } as React.CSSProperties
      }
      onPointerEnter={(e) => e.pointerType === 'mouse' && hover(true)}
      onPointerLeave={() => hover(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          // Closing the peek is all Escape does here (the focus view would close otherwise).
          e.preventDefault();
          setPinned(false);
          setFocused(false);
        }
      }}
    >
      <div className="lane-row">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? peekId : undefined}
          aria-label={`${view.label}. ${pinned ? 'Hide' : 'Pin'} output preview`}
          onClick={() => setPinned((p) => !p)}
          onFocus={(e) => setFocused(e.currentTarget.matches(':focus-visible'))}
          onBlur={() => {
            setFocused(false);
            setPinned(false);
          }}
          className={cx(
            'grid min-w-0 grid-cols-subgrid items-center rounded-chip text-left',
            // A crash's error line takes the sparkline and port tracks too: it needs the room.
            errorLine ? 'col-span-4' : 'col-span-2',
          )}
        >
          <span className="flex min-w-0 items-center gap-1 text-body-sm text-text-1">
            <ChevronRight
              aria-hidden
              strokeWidth={1.75}
              className={cx(
                'size-3.5 shrink-0 text-text-3 transition-transform duration-200 ease-out',
                open && 'rotate-90',
              )}
            />
            <span
              className={cx('truncate', !terminal.name.trim() && 'text-text-3')}
              title={terminalName(terminal)}
            >
              {terminalName(terminal)}
            </span>
          </span>
          <LaneCaption command={view.command} running={view.running} error={errorLine} />
        </button>

        {!errorLine && (
          <>
            <Sparkline terminalId={terminal.id} color={accent} error={view.tone === 'err'} />
            <span className="flex min-w-0 items-center">
              {port && <PortChip port={port} others={morePorts} />}
            </span>
          </>
        )}

        <span className="flex min-w-0 items-center justify-end gap-1.5 font-mono text-meta tabular text-text-3">
          <AnimatePresence initial={false} mode="popLayout">
            {view.exit ? (
              <motion.span
                key={view.exit.key}
                className="inline-flex items-center gap-1.5"
                exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
              >
                {crashed && (
                  <span aria-hidden className="lane-crash-dot size-1.5 rounded-full bg-st-err" />
                )}
                <ExitBadge code={view.exit.code} />
              </motion.span>
            ) : (
              <motion.span
                key="state"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
                className="inline-flex items-center gap-1.5"
              >
                <span
                  aria-hidden
                  data-level={view.running && streaming ? level : undefined}
                  className={cx(
                    'lane-dot size-1.5 rounded-full',
                    view.running ? 'bg-st-ok text-st-ok' : 'bg-st-idle text-st-idle',
                  )}
                />
                {uptime && <span title={`Running for ${uptime}`}>{uptime}</span>}
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            key="peek"
            // A full transform string stays on the compositor while the board streams.
            initial={{ opacity: 0, transform: 'translateY(-4px) scaleY(0.96)' }}
            animate={{ opacity: 1, transform: 'translateY(0px) scaleY(1)' }}
            exit={{
              opacity: 0,
              transform: 'translateY(-2px) scaleY(0.98)',
              transition: { duration: dur.fast, ease: ease.out },
            }}
            transition={{ duration: PEEK_IN_S, ease: ease.out }}
            className="pointer-events-none absolute inset-x-0 top-full z-20 mt-1 origin-top"
          >
            <TerminalPeek
              id={peekId}
              terminalId={terminal.id}
              label={`Latest output of ${terminalName(terminal)}`}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

/**
 * The lane's command column. After a crash the error line slides up into its place (§4.10),
 * in rose; the command stays in the tooltip.
 */
function LaneCaption({
  command,
  running,
  error,
}: {
  command: string | null;
  running: boolean;
  error: string | null;
}) {
  const still = useMotionLevel() !== 'full';
  return (
    <span
      className={cx(
        'relative flex min-w-0 overflow-hidden font-mono text-meta',
        error && 'col-span-3',
      )}
      title={error ? `${command ?? ''}\n${error}`.trim() : (command ?? undefined)}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={error ? `error:${error}` : 'command'}
          data-error-line={error ? '' : undefined}
          initial={{ opacity: 0, transform: slide(still, '100%') }}
          animate={{ opacity: 1, transform: slide(still, '0%'), transition: spring.snappy }}
          exit={{
            opacity: 0,
            transform: slide(still, '-100%'),
            transition: { duration: dur.fast, ease: ease.out },
          }}
          className={cx(
            'block min-w-0 truncate',
            error ? 'text-st-err-ink' : running ? 'text-text-2' : 'text-text-3',
          )}
        >
          {error ?? command ?? '—'}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
