import type { Terminal } from '@c-board/protocol';
import { ChevronRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { useNow } from '../anim/clock.js';
import { selectPortsByTerminal, useBoardList, useBoardShallow } from '../data/index.js';
import { dur, ease } from '../motion.js';
import { cx } from '../ui/cx.js';
import { ExitBadge } from '../ui/ExitBadge.js';
import { formatUptime, laneView, selectLaneExecution, uptimePeriod } from './lane.js';
import { PortChip } from './PortChip.js';
import { Sparkline } from './Sparkline.js';
import { TerminalPeek } from './TerminalPeek.js';
import { rateLevel } from './throughput.js';
import { useThroughput } from './useThroughput.js';

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
  const [level, setLevel] = useState<0 | 1 | 2 | 3>(0);
  useThroughput(terminal.id, (ring) => setLevel(rateLevel(ring)));

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
          className="col-span-2 grid min-w-0 grid-cols-subgrid items-center rounded-chip text-left"
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
            <span className="truncate" title={terminal.name}>
              {terminal.name}
            </span>
          </span>
          <span
            className={cx(
              'truncate font-mono text-meta',
              view.running ? 'text-text-2' : 'text-text-3',
            )}
            title={view.command ?? undefined}
          >
            {view.command ?? '—'}
          </span>
        </button>

        <Sparkline terminalId={terminal.id} color={accent} error={view.tone === 'err'} />

        <span className="flex min-w-0 items-center">
          {port && <PortChip port={port} others={morePorts} />}
        </span>

        <span className="flex min-w-0 items-center justify-end gap-1.5 font-mono text-meta tabular text-text-3">
          <AnimatePresence initial={false} mode="popLayout">
            {view.exit ? (
              <ExitBadge key={view.exit.key} code={view.exit.code} />
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
              label={`Latest output of ${terminal.name}`}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}
