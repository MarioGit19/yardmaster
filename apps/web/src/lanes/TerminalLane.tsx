import { type ClaudeSession, sessionSubtitle, type Terminal } from '@yardmaster/protocol';
import { ChevronRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'wouter';
import { useNow } from '../anim/clock.js';
import { DOT_PULSE } from '../anim/dotPulse.js';
import { useInView } from '../anim/useFrame.js';
import { type RateLoopSpec, useRateLoop } from '../anim/useRateLoop.js';
import {
  activityKey,
  isCrashExit,
  selectApproval,
  selectPortsByTerminal,
  selectTerminalSession,
  useActivityStep,
  useBoard,
  useBoardList,
  useBoardShallow,
} from '../data/index.js';
import { ActorInspector } from '../layouts/ActorInspector.js';
import { actorId } from '../layouts/scene.js';
import { dur, ease, loop, move, slide, spring, useMotionLevel } from '../motion.js';
import { ClaudeOrb } from '../orb/ClaudeOrb.js';
import { orbStateFor } from '../orb/model.js';
import { LiveCaption } from '../pod/LiveCaption.js';
import { type Caption, sessionCaption } from '../pod/model.js';
import { sessionHref } from '../routes.js';
import { useLaneStatus } from '../statusTokens.js';
import { claudeTerminalLabel } from '../terminal/claudeTerminal.js';
import { cx } from '../ui/cx.js';
import { ExitBadge } from '../ui/ExitBadge.js';
import { StatusDot } from '../ui/StatusDot.js';
import {
  formatUptime,
  laneView,
  selectLaneExecution,
  terminalDisplay,
  uptimePeriod,
} from './lane.js';
import { PortChip } from './PortChip.js';
import { Sparkline } from './Sparkline.js';
import { TerminalPeek } from './TerminalPeek.js';
import { useErrorLine } from './useErrorLine.js';

/** Hovering across lanes shouldn't flash a peek for every lane the pointer crosses. */
const PEEK_DELAY_MS = 140;

// The flow-light comet along the lane's bottom edge and the running dot's pulse, both faster the
// more the lane writes (§4.10). Rates are per activity step, relative to step 1.
const COMET: RateLoopSpec = {
  // motion-still: only runs at Full; Reduced shows the static CSS glow.
  keyframes: [{ transform: 'translateX(-100%)' }, { transform: 'translateX(260%)' }],
  durationMs: loop.comet * 1000,
  easing: 'linear',
  pseudoElement: '::after',
};
const COMET_RATE = [1, 1, 1.5, 2.4] as const;
const PULSE_RATE = [1, 1, 1.45, 2.15] as const;

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
  // A Claude terminal: its session's orb, name and caption, and it opens the session's chat.
  const session = useBoard(selectTerminalSession(terminal.id));
  const display = terminalDisplay(terminal, execution, session);
  const name = display.name;
  const view = useLaneStatus(terminal, laneView(terminal, execution, name));
  const still = useMotionLevel() !== 'full';
  const rowRef = useRef<HTMLDivElement>(null);
  // Pulse speed and comet follow the store's activity level for the terminal (§4.10).
  const level = useActivityStep(activityKey.terminal(terminal.id));
  const crashed = isCrashExit(view.exit?.code);
  const errorLine = useErrorLine(crashed ? (view.exit?.key ?? null) : null);
  const approvalId =
    session?.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const claude = session && terminal.projectId ? { session, projectId: terminal.projectId } : null;

  const now = useNow(view.startedAt === null ? null : uptimePeriod(Date.now() - view.startedAt));
  const uptime = view.startedAt === null ? null : formatUptime(now - view.startedAt);

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A TUI's raw bytes make no sense as six lines: Claude lanes have no peek.
  // The inspector shows the same lines: no peek under it.
  const [inspecting, setInspecting] = useState(false);
  const open = !claude && !inspecting && (pinned || hovered || focused);
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
  // The comet and the dot's pulse run only on screen.
  const onScreen = useInView(rowRef);
  useRateLoop(rowRef, COMET, COMET_RATE[level], streaming && !still && onScreen);
  const [port, ...morePorts] = ports;

  return (
    <li
      data-lane={terminal.id}
      data-terminal-name={terminal.name}
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
        // Keys from the inspector's portal bubble here too; they aren't the peek's to take.
        if (e.key === 'Escape' && open && e.currentTarget.contains(e.target as Node)) {
          // Closing the peek is all Escape does here (the focus view would close otherwise).
          e.preventDefault();
          setPinned(false);
          setFocused(false);
        }
      }}
    >
      <div ref={rowRef} className="lane-row">
        {claude ? (
          <ClaudeLaneHead
            session={claude.session}
            caption={sessionCaption(claude.session, approval)}
            name={name}
            title={sessionSubtitle(claude.session) ?? display.raw ?? name}
            href={sessionHref(claude.projectId, claude.session.id)}
            accent={accent}
          />
        ) : (
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
                  'size-3.5 shrink-0 text-text-3 moving:transition-transform duration-base ease-out',
                  open && 'rotate-90',
                )}
              />
              <span
                data-lane-name
                className={cx('truncate', !terminal.name.trim() && 'text-text-3')}
                title={display.raw ? `${name} (${display.raw})` : name}
              >
                {name}
              </span>
            </span>
            <LaneCaption command={view.command} running={view.running} error={errorLine} />
          </button>
        )}

        {!errorLine && (
          <>
            <Sparkline
              terminalId={terminal.id}
              color={accent}
              error={view.tone === 'err'}
              className="pod-dim"
            />
            <span className="flex min-w-0 items-center">
              {port && <PortChip port={port} others={morePorts} />}
            </span>
          </>
        )}

        <ActorInspector
          projectId={terminal.projectId ?? ''}
          actorId={claude ? actorId.session(claude.session.id) : actorId.terminal(terminal.id)}
          label={`${name}, details`}
          onOpenChange={setInspecting}
          trigger={
            <button
              type="button"
              aria-label={`Details for ${name}`}
              data-inspect={
                claude ? actorId.session(claude.session.id) : actorId.terminal(terminal.id)
              }
              className="relative flex min-w-0 items-center justify-end gap-1.5 rounded-chip font-mono text-meta tabular text-text-2 after:absolute after:-inset-y-2 after:-inset-x-1 hover:text-text-1"
            >
              <AnimatePresence initial={false} mode="popLayout">
                {view.exit ? (
                  <motion.span
                    key={view.exit.key}
                    className="inline-flex items-center gap-1.5"
                    exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
                  >
                    {crashed && (
                      <span
                        aria-hidden
                        className="lane-crash-dot size-1.5 rounded-full bg-st-err"
                      />
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
                    {view.tone === 'stale' ? (
                      <StatusDot tone="stale" label="Stale" />
                    ) : (
                      <LaneDot running={view.running} level={streaming ? level : 0} />
                    )}
                    {uptime && <span title={`Running for ${uptime}`}>{uptime}</span>}
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          }
        />
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            key="peek"
            // A full transform string stays on the compositor while the board streams.
            initial={{ opacity: 0, transform: move(still, 'translateY(-4px) scaleY(0.96)') }}
            animate={{ opacity: 1, transform: move(still, 'translateY(0px) scaleY(1)') }}
            exit={{
              opacity: 0,
              transform: move(still, 'translateY(-2px) scaleY(0.98)'),
              transition: { duration: dur.fast, ease: ease.out },
            }}
            transition={{ duration: dur.fast, ease: ease.out }}
            className="pointer-events-none absolute inset-x-0 top-full z-20 mt-1 origin-top"
          >
            <TerminalPeek id={peekId} terminalId={terminal.id} label={`Latest output of ${name}`} />
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

/** A Claude terminal's name and caption tracks: a link to the session's chat. */
function ClaudeLaneHead({
  session,
  caption,
  name,
  title,
  href,
  accent,
}: {
  session: ClaudeSession;
  caption: Caption;
  name: string;
  /** The tooltip: Claude Code's own name or summary for the session. */
  title: string;
  href: string;
  accent: string;
}) {
  return (
    <Link
      href={href}
      aria-label={claudeTerminalLabel(name, caption.text)}
      data-claude-lane={session.id}
      className="col-span-2 grid min-w-0 grid-cols-subgrid items-center rounded-chip text-left"
    >
      <span className="flex min-w-0 items-center gap-1 text-body-sm text-text-1">
        <span aria-hidden className="pod-dim flex size-3.5 shrink-0 items-center justify-center">
          <ClaudeOrb
            state={orbStateFor(session.status)}
            size={12}
            accent={accent}
            tool={session.status.kind === 'tool' ? session.status.tool : null}
            showToolLabel={false}
          />
        </span>
        <span data-lane-name className="truncate" title={title}>
          {name}
        </span>
      </span>
      <LiveCaption caption={caption} className="text-meta" />
    </Link>
  );
}

/** The uptime dot, a Running mark; quiet lanes keep its space and show nothing. */
function LaneDot({ running, level }: { running: boolean; level: 0 | 1 | 2 | 3 }) {
  const ref = useRef<HTMLSpanElement>(null);
  const full = useMotionLevel() === 'full';
  const pulsing = running && level > 0;
  const onScreen = useInView(ref);
  useRateLoop(ref, DOT_PULSE, PULSE_RATE[level], pulsing && full && onScreen);
  return (
    <span
      ref={ref}
      aria-hidden
      data-level={pulsing ? level : undefined}
      className={cx(
        'lane-dot pod-dim size-1.5 rounded-full',
        running ? 'bg-st-tool text-st-tool' : 'invisible',
      )}
    />
  );
}

/**
 * The lane's command column. A new command slides in like a session caption; after a crash the
 * error line slides up into its place (§4.10), in rose, and the command stays in the tooltip.
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
          key={error ? `error:${error}` : `command:${command ?? ''}`}
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
            error ? 'text-st-err-ink' : running ? 'text-text-1' : 'text-text-2',
          )}
        >
          {error ?? command ?? '—'}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
