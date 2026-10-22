import { toolFamily } from '@c-board/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  Check,
  ChevronRight,
  FilePen,
  FileText,
  GitFork,
  Globe,
  ListChecks,
  Search,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { dur, ease, spring } from '../motion.js';
import { cx } from '../ui/cx.js';
import { Markdown } from './Markdown.js';
import { type ToolRow, type TranscriptRow, toolSummary } from './transcript.js';

/** Within this many px of the bottom the list counts as "at the latest" and follows new rows. */
export const STICK_THRESHOLD_PX = 48;
/** Rows newer than this still play the enter animation when they mount. */
const ENTER_WINDOW_MS = 600;
/** User messages longer than this collapse behind "Show more". */
const USER_CLAMP_CHARS = 700;
const USER_CLAMP_LINES = 12;

const TAIL_ID = '__tail';
/** Frames a jump to the end keeps re-aiming while rows measure. */
const SETTLE_FRAMES = 30;

type Item = TranscriptRow | { kind: 'tail'; id: typeof TAIL_ID; text: string };

const FAMILY_ICON = {
  bash: Terminal,
  edit: FilePen,
  read: FileText,
  search: Search,
  web: Globe,
  task: GitFork,
  todo: ListChecks,
  other: Wrench,
} as const;

function estimate(item: Item | undefined): number {
  if (!item) return 40;
  switch (item.kind) {
    case 'tool':
      return 36;
    case 'thinking':
      return 40;
    case 'user':
      return 56 + Math.min(10, Math.floor(item.text.length / 80)) * 20;
    default:
      return 32 + Math.min(40, Math.ceil(item.text.length / 90)) * 22;
  }
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const fullTime = (ts: number | null) => (ts === null ? undefined : timeFormat.format(ts));

export interface MessageListProps {
  rows: readonly TranscriptRow[];
  /** Text Claude is still writing, shown after the last row with a caret. */
  tail: string | null;
  /** Session cwd, so tool paths show relative. */
  cwd?: string;
}

/**
 * The virtualized transcript. It follows new messages while it is scrolled to the bottom, and
 * offers a "Jump to latest" pill once the reader scrolls away.
 */
export function MessageList({ rows, tail, cwd }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const items: Item[] =
    tail === null ? [...rows] : [...rows, { kind: 'tail', id: TAIL_ID, text: tail }];
  const [atEnd, setAtEnd] = useState(true);
  const atEndRef = useRef(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const firstSeen = useRef(new Map<string, number>());
  const initial = useRef<Set<string> | null>(null);
  const awayFrom = useRef(rows.length);

  if (initial.current === null && rows.length > 0) {
    initial.current = new Set(rows.map((r) => r.id));
  }

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimate(items[i]),
    getItemKey: (i) => items[i]?.id ?? i,
    overscan: 6,
    paddingStart: 16,
    paddingEnd: 24,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: STICK_THRESHOLD_PX,
    onChange: (instance) => {
      const end = instance.isAtEnd(STICK_THRESHOLD_PX);
      if (end === atEndRef.current) return;
      atEndRef.current = end;
      setAtEnd(end);
    },
  });

  // Jumping to the end lands on estimated sizes; rows measured on the way in can move the end, so
  // it re-aims for a few frames until the bottom holds. Any input from the reader stops it.
  const settling = useRef(0);
  const stopSettling = useCallback(() => cancelAnimationFrame(settling.current), []);
  const toEnd = useCallback(() => {
    cancelAnimationFrame(settling.current);
    virtualizer.scrollToEnd();
    let frames = 0;
    let held = 0;
    const check = () => {
      if (++frames > SETTLE_FRAMES) return;
      if (virtualizer.isAtEnd(1)) {
        if (++held >= 3) return;
      } else {
        held = 0;
        virtualizer.scrollToEnd();
      }
      settling.current = requestAnimationFrame(check);
    };
    settling.current = requestAnimationFrame(check);
  }, [virtualizer]);
  useEffect(() => stopSettling, [stopSettling]);

  // A conversation opens at its latest message; `anchorTo: 'end'` keeps it there afterwards.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useLayoutEffect(() => {
    toEnd();
  }, []);

  useEffect(() => {
    if (atEnd) awayFrom.current = rows.length;
  }, [atEnd, rows.length]);
  const unseen = atEnd ? 0 : Math.max(0, rows.length - awayFrom.current);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const now = Date.now();
  const entering = (id: string) => {
    if (initial.current?.has(id) ?? true) return false;
    let seen = firstSeen.current.get(id);
    if (seen === undefined) {
      seen = now;
      firstSeen.current.set(id, seen);
    }
    return now - seen < ENTER_WINDOW_MS;
  };

  const virtualItems = virtualizer.getVirtualItems();
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-message-list
        data-count={items.length}
        data-at-end={atEnd ? '' : undefined}
        role="log"
        aria-label="Conversation"
        aria-live="off"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must be keyboard scrollable
        tabIndex={0}
        onWheel={stopSettling}
        onPointerDown={stopSettling}
        onKeyDown={stopSettling}
        onTouchStart={stopSettling}
        className="message-scroll h-full overflow-y-auto overscroll-contain"
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((v) => {
            const item = items[v.index];
            if (!item) return null;
            const prev = items[v.index - 1];
            const turnStart = item.kind === 'user' && v.index > 0;
            return (
              <div
                key={v.key}
                ref={virtualizer.measureElement}
                data-index={v.index}
                data-row={item.kind}
                className="absolute top-0 left-0 w-full px-5"
                style={{ transform: `translateY(${v.start}px)` }}
              >
                <div
                  className={cx(
                    'mx-auto max-w-3xl',
                    turnStart
                      ? 'pt-6'
                      : prev
                        ? item.kind === 'tool' && prev.kind === 'tool'
                          ? 'pt-1'
                          : 'pt-3'
                        : '',
                    item.kind !== 'tail' && entering(item.id) && 'msg-enter',
                  )}
                >
                  <Row item={item} cwd={cwd} expanded={expanded.has(item.id)} onToggle={toggle} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
        <AnimatePresence>
          {!atEnd && (
            <motion.button
              key="jump"
              type="button"
              onClick={toEnd}
              // Whole transform strings stay on the compositor while messages stream in.
              initial={{ opacity: 0, transform: 'translateY(8px) scale(0.96)' }}
              animate={{ opacity: 1, transform: 'translateY(0px) scale(1)' }}
              exit={{
                opacity: 0,
                transform: 'translateY(4px) scale(0.98)',
                transition: { duration: dur.fast, ease: ease.out },
              }}
              transition={spring.snappy}
              className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-bg-2 pr-3.5 pl-3 text-label text-text-1 shadow-raised backdrop-blur-[16px] hover:bg-bg-1"
            >
              <ArrowDown aria-hidden className="size-3.5" strokeWidth={1.75} />
              Jump to latest
              {unseen > 0 && (
                <span className="tabular rounded-full bg-st-work/20 px-1.5 text-meta text-st-work">
                  {unseen > 99 ? '99+' : unseen}
                </span>
              )}
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

const Row = memo(function Row({
  item,
  cwd,
  expanded,
  onToggle,
}: {
  item: Item;
  cwd: string | undefined;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  switch (item.kind) {
    case 'user':
      return <UserBubble row={item} expanded={expanded} onToggle={onToggle} />;
    case 'assistant':
      return (
        <div title={fullTime(item.ts)}>
          <Markdown text={item.text} />
        </div>
      );
    case 'tail':
      return <Markdown text={item.text} streaming />;
    case 'thinking':
      return <Thinking row={item} expanded={expanded} onToggle={onToggle} />;
    case 'tool':
      return <ToolLine row={item} cwd={cwd} />;
  }
});

function UserBubble({
  row,
  expanded,
  onToggle,
}: {
  row: Extract<TranscriptRow, { kind: 'user' }>;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const lines = row.text.split('\n');
  const long = row.text.length > USER_CLAMP_CHARS || lines.length > USER_CLAMP_LINES;
  const shown =
    long && !expanded
      ? `${lines.slice(0, USER_CLAMP_LINES).join('\n').slice(0, USER_CLAMP_CHARS).trimEnd()}…`
      : row.text;
  return (
    <div className="flex justify-end">
      <div
        title={fullTime(row.ts)}
        className="max-w-[min(85%,36rem)] rounded-panel rounded-br-chip border border-line bg-bg-2 px-3.5 py-2 text-body text-text-1 shadow-raised"
      >
        <p className="whitespace-pre-wrap break-words">{shown}</p>
        {long && (
          <button
            type="button"
            onClick={() => onToggle(row.id)}
            className="mt-1 text-label text-text-3 hover:text-text-1"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  );
}

function Thinking({
  row,
  expanded,
  onToggle,
}: {
  row: Extract<TranscriptRow, { kind: 'thinking' }>;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => onToggle(row.id)}
        className="group -ml-1 flex h-7 min-w-0 max-w-full items-center gap-1.5 self-start rounded-chip px-1 text-label text-text-3 transition-colors duration-150 hover:text-text-2"
      >
        <ChevronRight
          aria-hidden
          className={cx(
            'size-3.5 shrink-0 transition-transform duration-200 ease-out',
            expanded && 'rotate-90',
          )}
          strokeWidth={1.75}
        />
        <span className="shrink-0">Thinking</span>
        {!expanded && (
          <span className="truncate text-text-3/80 italic">{row.text.split('\n')[0]}</span>
        )}
      </button>
      {expanded && (
        <div
          id={id}
          className="msg-fade mt-1 ml-1.5 whitespace-pre-wrap break-words border-line-strong border-l pl-3 text-body-sm text-text-2 italic"
        >
          {row.text}
        </div>
      )}
    </div>
  );
}

/** A one-line tool call; 7.9 turns these into full tool cards. */
function ToolLine({ row, cwd }: { row: ToolRow; cwd: string | undefined }) {
  const Icon = FAMILY_ICON[toolFamily(row.name)];
  const summary = toolSummary(row.name, row.input, cwd);
  const state: ReactNode =
    row.result === null ? (
      <span className="flex items-center gap-1.5 text-st-tool">
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-st-tool shadow-[0_0_0_3px_var(--st-tool-glow)]"
        />
        running
      </span>
    ) : row.result.isError ? (
      <span className="flex items-center gap-1 text-st-err">
        <X aria-hidden className="size-3.5" strokeWidth={2} />
        failed
      </span>
    ) : (
      <span className="flex items-center text-st-ok">
        <Check aria-label="done" className="size-3.5" strokeWidth={2} />
      </span>
    );
  return (
    <div
      title={row.result?.isError ? row.result.text : undefined}
      className="flex h-8 min-w-0 items-center gap-2.5 rounded-control border border-line bg-bg-1 px-2.5 text-label"
    >
      <Icon aria-hidden className="size-3.5 shrink-0 text-text-3" strokeWidth={1.5} />
      <span className="shrink-0 font-medium text-text-1">{row.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-text-3" title={summary}>
        {summary}
      </span>
      <span className="shrink-0 text-meta">{state}</span>
    </div>
  );
}
