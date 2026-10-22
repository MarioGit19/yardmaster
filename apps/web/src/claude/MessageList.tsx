import { parseToolCall, type TodoStatus } from '@c-board/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { dur, ease, move, spring, useMotionLevel } from '../motion.js';
import { redact, redactDeep } from '../redact/redact.js';
import { reveal, useMasked, useRedactOn } from '../redact/reveal.js';
import { cx } from '../ui/cx.js';
import { Markdown } from './Markdown.js';
import { ToolCard } from './tools/ToolCard.js';
import { ToolViewState } from './tools/viewState.js';
import type { ToolRow, TranscriptRow } from './transcript.js';

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

function estimate(item: Item | undefined): number {
  if (!item) return 40;
  switch (item.kind) {
    case 'tool':
      return estimateTool(item);
    case 'thinking':
      return 40;
    case 'user':
      return 56 + Math.min(10, Math.floor(item.text.length / 80)) * 20;
    default:
      return 32 + Math.min(40, Math.ceil(item.text.length / 90)) * 22;
  }
}

const CHIP_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);

function estimateTool(row: ToolRow): number {
  if (CHIP_TOOLS.has(row.name)) return 28;
  const o = (row.input && typeof row.input === 'object' ? row.input : {}) as Record<
    string,
    unknown
  >;
  switch (row.name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const text = [o.old_string, o.new_string, o.content].filter((v) => typeof v === 'string');
      const lines = text.join('\n').split('\n').length;
      return 74 + Math.min(18, lines) * 20 + (lines > 18 ? 28 : 0);
    }
    case 'TodoWrite':
      return 54 + (Array.isArray(o.todos) ? o.todos.length : 0) * 24;
    default:
      return 34;
  }
}

/** The todos of the TodoWrite call before `index`, so a new list can tell what just finished. */
function previousTodos(
  items: readonly Item[],
  index: number,
): { content: string; status: TodoStatus }[] | null {
  for (let i = index - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== 'tool' || item.name !== 'TodoWrite') continue;
    const call = parseToolCall(item.name, item.input);
    return call.kind === 'todo' ? call.todos : null;
  }
  return null;
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
  const still = useMotionLevel() !== 'full';
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
    <ToolViewState>
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
              const enter = item.kind !== 'tail' && entering(item.id);
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
                      enter && (item.kind === 'tool' ? 'tool-enter' : 'msg-enter'),
                    )}
                  >
                    <Row
                      item={item}
                      cwd={cwd}
                      expanded={expanded.has(item.id)}
                      onToggle={toggle}
                      entering={enter}
                      previousTodos={
                        enter && item.kind === 'tool' && item.name === 'TodoWrite'
                          ? previousTodos(items, v.index)
                          : undefined
                      }
                    />
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
                initial={{ opacity: 0, transform: move(still, 'translateY(8px) scale(0.96)') }}
                animate={{ opacity: 1, transform: move(still, 'translateY(0px) scale(1)') }}
                exit={{
                  opacity: 0,
                  transform: move(still, 'translateY(4px) scale(0.98)'),
                  transition: { duration: dur.fast, ease: ease.out },
                }}
                transition={spring.snappy}
                className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-bg-2 pr-4 pl-3 text-label text-text-1 shadow-raised backdrop-blur-[16px] hover:bg-bg-1"
              >
                <ArrowDown aria-hidden className="size-3.5" strokeWidth={1.75} />
                Jump to latest
                {unseen > 0 && (
                  <span className="tabular rounded-full bg-st-work/20 px-1.5 text-meta text-st-work-ink">
                    {unseen > 99 ? '99+' : unseen}
                  </span>
                )}
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </ToolViewState>
  );
}

/** The row with its secrets masked; the same object when it has none. */
export function redactItem(item: Item): Item {
  if (item.kind !== 'tool') {
    const text = redact(item.text);
    return text === item.text ? item : { ...item, text };
  }
  const input = redactDeep(item.input);
  const resultText = item.result ? redact(item.result.text) : null;
  if (input === item.input && resultText === (item.result?.text ?? null)) return item;
  return {
    ...item,
    input,
    result: item.result && resultText !== null ? { ...item.result, text: resultText } : null,
  };
}

interface RowProps {
  item: Item;
  cwd: string | undefined;
  expanded: boolean;
  onToggle: (id: string) => void;
  entering: boolean;
  previousTodos: { content: string; status: TodoStatus }[] | null | undefined;
}

/** A row, masked while the redact setting is on (PRD §8.7), with a per-row reveal. */
const Row = memo(function Row(props: RowProps) {
  const { item } = props;
  const key = `row:${item.id}`;
  const on = useRedactOn();
  const masked = useMasked(key);
  const redacted = useMemo(() => (on ? redactItem(item) : item), [on, item]);
  if (redacted === item) return <RowBody {...props} />;
  return (
    <div className="flex flex-col">
      <RowBody {...props} item={masked ? redacted : item} />
      <button
        type="button"
        aria-pressed={!masked}
        onClick={() => reveal.toggle(key)}
        data-reveal={masked ? 'hidden' : 'shown'}
        className={cx(
          'mt-1 flex h-6 items-center gap-1.5 rounded-chip px-1 text-meta text-text-3 transition-colors duration-150 hover:text-text-1',
          item.kind === 'user' ? 'self-end' : 'self-start',
        )}
      >
        {masked ? (
          <EyeOff aria-hidden className="size-3.5" strokeWidth={1.5} />
        ) : (
          <Eye aria-hidden className="size-3.5" strokeWidth={1.5} />
        )}
        {masked ? 'Secrets hidden · Reveal' : 'Hide secrets'}
      </button>
    </div>
  );
});

function RowBody({ item, cwd, expanded, onToggle, entering, previousTodos }: RowProps) {
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
      return <ToolCard row={item} cwd={cwd} entering={entering} previousTodos={previousTodos} />;
  }
}

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
        className="max-w-[min(85%,36rem)] rounded-panel rounded-br-chip border border-line bg-bg-2 px-4 py-2 text-body text-text-1 shadow-raised"
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
