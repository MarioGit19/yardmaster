import { parseToolCall, type TodoStatus, type ToolCall, toolFamily } from '@yardmaster/protocol';
import {
  Check,
  ChevronRight,
  ExternalLink,
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
import { memo, type ReactNode, useId, useMemo, useRef } from 'react';
import { DOT_PULSE } from '../../anim/dotPulse.js';
import { useInView } from '../../anim/useFrame.js';
import { useRateLoop } from '../../anim/useRateLoop.js';
import { dur, ease, move, spring, useMotionLevel } from '../../motion.js';
import { countOf, plural } from '../../plural.js';
import { usePreference } from '../../prefs.js';
import { cx } from '../../ui/cx.js';
import { DrawnCheck } from '../../ui/DrawnCheck.js';
import { ExitBadge } from '../../ui/ExitBadge.js';
import { SegmentThumb, useSegmentThumb } from '../../ui/SegmentThumb.js';
import { useScrollFocus } from '../../ui/useScrollFocus.js';
import { langFor, type TokenLine, useHighlight } from '../highlight.js';
import { Markdown } from '../Markdown.js';
import { type ToolRow, toolSummary } from '../transcript.js';
import { DIFF_LAYOUTS, DiffView, diffLayoutPreference } from './DiffView.js';
import { buildHunk, type Hunk } from './diff.js';
import {
  bashExitCode,
  bashOutput,
  editStartLine,
  extensionOf,
  globCount,
  grepCount,
  listedPaths,
  numberedLines,
  pathParts,
  prettyJson,
  readExtent,
  stripAnsi,
  toolLabel,
  urlParts,
  urlsIn,
} from './results.js';
import { useStickyFlag } from './viewState.js';

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

/** Result text longer than this is cut before rendering. */
const MAX_RESULT_CHARS = 20_000;
const PREVIEW_LINES = 40;

export interface ToolCardProps {
  row: ToolRow;
  /** Session cwd, so paths show relative. */
  cwd?: string;
  /** The card just arrived: checks draw in, and badges pop. */
  entering?: boolean;
  /** For TodoWrite: the todos of the previous list, so only newly finished items draw in. */
  previousTodos?: readonly { content: string; status: TodoStatus }[] | null;
}

/** One tool call and its result, rendered by kind (DESIGN.md §4.6). */
export const ToolCard = memo(function ToolCard({
  row,
  cwd,
  entering = false,
  previousTodos,
}: ToolCardProps) {
  const call = useMemo(() => parseToolCall(row.name, row.input), [row.name, row.input]);
  // Badges pop when a result arrives while the card is on screen, not on every remount.
  const wasRunning = useRef(row.result === null);
  const appear = entering || wasRunning.current;
  const props = { row, cwd, appear };
  switch (call.kind) {
    case 'bash':
      return <BashCard {...props} call={call} />;
    case 'edit':
    case 'write':
      return <EditCard {...props} call={call} />;
    case 'read':
    case 'grep':
    case 'glob':
    case 'fetch':
    case 'search':
      return <ChipCard {...props} call={call} />;
    case 'todo':
      return <TodoCard {...props} call={call} draw={entering} previous={previousTodos ?? null} />;
    case 'task':
      return <TaskCard {...props} call={call} />;
    case 'other':
      return <OtherCard {...props} />;
  }
});

interface CardProps {
  row: ToolRow;
  cwd: string | undefined;
  appear: boolean;
}
type CallOf<K extends ToolCall['kind']> = Extract<ToolCall, { kind: K }>;

// Shared pieces

/**
 * Whether this card was running when it mounted, so its result arrives on screen: the check pops
 * and a failure glitches then, but not when the list scrolls a finished card back into view.
 */
function useLiveResult(row: ToolRow): boolean {
  const wasRunning = useRef(row.result === null);
  return wasRunning.current && row.result !== null;
}

/** The rose glitch for a failure that just happened (DESIGN.md §3 rule 6). */
function useGlitch(row: ToolRow): string | false {
  const live = useLiveResult(row);
  return live && row.result?.isError === true && 'tool-glitch';
}

/** A running tool's dot, with a ring pulsing out of it like a streaming lane's. */
function RunningDot() {
  const ref = useRef<HTMLSpanElement>(null);
  const full = useMotionLevel() === 'full';
  const onScreen = useInView(ref);
  useRateLoop(ref, DOT_PULSE, 1, full && onScreen);
  return (
    <span
      ref={ref}
      aria-hidden
      className="tool-running size-1.5 rounded-full bg-st-tool text-st-tool shadow-[0_0_0_3px_var(--st-tool-glow)]"
    />
  );
}

function ToolState({ row }: { row: ToolRow }) {
  const live = useLiveResult(row);
  const still = useMotionLevel() !== 'full';
  if (row.result === null) {
    return (
      <span className="flex items-center gap-1.5 text-meta text-st-tool-ink">
        <RunningDot />
        running
      </span>
    );
  }
  if (row.result.isError) {
    return (
      <span className="flex items-center gap-1 text-meta text-st-err-ink">
        <X aria-hidden className="size-3.5" strokeWidth={2} />
        failed
      </span>
    );
  }
  // Success pops the check in (scale .6 → 1 on `snappy`), as a transform string so it stays on
  // the compositor while the transcript streams.
  return (
    <motion.span
      data-done
      initial={live ? { opacity: 0, transform: move(still, 'scale(0.6)') } : false}
      animate={{ opacity: 1, transform: move(still, 'scale(1)') }}
      transition={{ default: spring.snappy, opacity: { duration: dur.fast, ease: ease.out } }}
      className="flex"
    >
      <Check aria-label="done" className="size-3.5 text-st-ok-ink" strokeWidth={2} />
    </motion.span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden
      className={cx(
        'size-3.5 shrink-0 text-text-3 moving:transition-transform duration-base ease-out',
        open && 'rotate-90',
      )}
      strokeWidth={1.75}
    />
  );
}

function PathLabel({ path, cwd }: { path: string; cwd: string | undefined }) {
  const { dir, base } = pathParts(path, cwd);
  return (
    <span className="flex min-w-0 font-mono" title={path}>
      {dir && <span className="min-w-0 truncate text-text-3">{dir}</span>}
      <span className="shrink-0 text-text-1">{base}</span>
    </span>
  );
}

/**
 * The card frame: a header row that toggles the body when there is one. `open` is sticky per
 * row, so the card keeps its state when the list virtualizes it away and back.
 */
function Card({
  row,
  kind,
  icon,
  label,
  summary,
  extra,
  status,
  defaultOpen,
  children,
}: {
  row: ToolRow;
  kind: ToolCall['kind'];
  icon?: ReactNode;
  label: ReactNode;
  summary: ReactNode;
  extra?: ReactNode;
  status: ReactNode;
  defaultOpen: boolean;
  children?: ReactNode;
}) {
  const [open, toggle] = useStickyFlag(row.id, defaultOpen);
  const bodyId = useId();
  const glitch = useGlitch(row);
  const Icon = FAMILY_ICON[toolFamily(row.name)];
  const head = (
    <>
      {icon ?? <Icon aria-hidden className="size-3.5 shrink-0 text-text-3" strokeWidth={1.5} />}
      <span className="shrink-0 font-medium text-text-1">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{summary}</span>
      {extra}
      <span data-tool-status className="flex shrink-0 items-center">
        {status}
      </span>
    </>
  );
  const headClass =
    'flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left text-label touch:h-11';
  return (
    <div
      data-tool={row.name}
      data-tool-kind={kind}
      data-state={row.result === null ? 'running' : row.result.isError ? 'error' : 'done'}
      data-open={children && open ? '' : undefined}
      className={cx('tool-card overflow-hidden rounded-control border border-line bg-bg-1', glitch)}
    >
      {children ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
          className={cx(headClass, 'tool-head')}
        >
          {head}
          <Chevron open={open} />
        </button>
      ) : (
        <div className={headClass}>{head}</div>
      )}
      {children && open && (
        <div id={bodyId} className="msg-fade border-line border-t">
          {children}
        </div>
      )}
    </div>
  );
}

/** Result text as monospace, cut to a sane size. */
function ResultText({ text, tone }: { text: string; tone?: 'error' }) {
  const clipped = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…` : text;
  const ref = useScrollFocus<HTMLPreElement>(tone === 'error' ? 'Error output' : 'Output');
  return (
    <pre
      ref={ref}
      className={cx(
        'max-h-72 overflow-auto px-3 py-2 font-mono text-label leading-5 whitespace-pre-wrap break-words',
        tone === 'error' ? 'bg-st-err/[0.06] text-st-err-ink' : 'text-text-2',
      )}
    >
      {clipped || <span className="font-sans text-text-2 italic">No output</span>}
    </pre>
  );
}

/** Highlighted code lines with numbers, for Read previews and JSON. */
function CodeLines({
  lines,
  lang,
  firstNo,
  more,
}: {
  lines: readonly string[];
  lang: string | null;
  firstNo: number | null;
  /** Lines left out after these. */
  more: number;
}) {
  const code = lines.join('\n');
  const tokens = useHighlight(code, langFor(lang));
  const width = String((firstNo ?? 1) + lines.length).length + 2;
  const ref = useScrollFocus<HTMLDivElement>('Code');
  return (
    <div ref={ref} className="max-h-80 overflow-auto py-1.5 font-mono text-label leading-5">
      <div className="w-max min-w-full">
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          <div key={i} className="flex">
            {firstNo !== null && (
              <span
                className="diff-no shrink-0 select-none pr-3 text-right"
                style={{ width: `${width}ch` }}
              >
                {firstNo + i}
              </span>
            )}
            <span className={cx('pr-4 whitespace-pre text-text-1', firstNo === null && 'pl-3')}>
              <TokenText text={line} tokens={tokens?.[i]} />
            </span>
          </div>
        ))}
      </div>
      {more > 0 && (
        <p className="px-3 pt-1 font-sans text-meta text-text-2">
          {more} more {plural(more, 'line')}
        </p>
      )}
    </div>
  );
}

function TokenText({ text, tokens }: { text: string; tokens: TokenLine | undefined }) {
  if (!tokens || tokens.map((t) => t[0]).join('') !== text) return text;
  return tokens.map(([content, color], i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
    <span key={i} style={color ? { color } : undefined}>
      {content}
    </span>
  ));
}

// Bash

function BashCard({ row, appear, call }: CardProps & { call: CallOf<'bash'> }) {
  const exit = bashExitCode(row.result);
  const [first = '', ...restLines] = call.command.split('\n');
  const output = row.result ? bashOutput(row.result.text) : null;
  const commandRef = useScrollFocus<HTMLPreElement>('Command');
  return (
    <Card
      row={row}
      kind="bash"
      label={row.name}
      summary={
        <span
          className="min-w-0 truncate font-mono text-text-2"
          title={call.description ?? call.command}
        >
          {first}
          {restLines.length > 0 && <span className="text-text-3"> …</span>}
        </span>
      }
      extra={
        call.background ? (
          <span className="shrink-0 rounded-chip bg-bg-2 px-1.5 text-meta text-text-2">
            background
          </span>
        ) : null
      }
      status={
        exit === null ? (
          <ToolState row={row} />
        ) : (
          <AnimatePresence initial={appear}>
            <ExitBadge key={exit} code={exit} />
          </AnimatePresence>
        )
      }
      defaultOpen={exit !== null && exit !== 0}
    >
      {restLines.length > 0 && (
        <pre
          ref={commandRef}
          className="max-h-40 overflow-auto border-line border-b px-3 py-2 font-mono text-label leading-5 whitespace-pre-wrap text-text-1"
        >
          <span className="text-text-3">$ </span>
          {call.command}
        </pre>
      )}
      {output === null ? (
        <p className="px-3 py-2 text-meta text-text-2">Waiting for output…</p>
      ) : (
        <ResultText text={output} tone={exit !== 0 ? 'error' : undefined} />
      )}
    </Card>
  );
}

// Edit, MultiEdit, Write

function EditCard({ row, cwd, call }: CardProps & { call: CallOf<'edit'> | CallOf<'write'> }) {
  const resultText = row.result && !row.result.isError ? row.result.text : null;
  const hunks: Hunk[] = useMemo(() => {
    if (call.kind === 'write') return [buildHunk('', call.content, 1)];
    return call.edits.map((e) => {
      const start = resultText ? editStartLine(resultText, e.newString) : null;
      return buildHunk(e.oldString, e.newString, start);
    });
  }, [call, resultText]);
  const added = hunks.reduce((n, h) => n + h.added, 0);
  const removed = hunks.reduce((n, h) => n + h.removed, 0);
  const note =
    call.kind === 'write'
      ? resultText && /created/i.test(resultText)
        ? 'New file'
        : 'Whole file written'
      : call.edits.length > 1
        ? `${call.edits.length} edits`
        : call.edits[0]?.replaceAll
          ? 'Replace all'
          : null;
  return (
    <Card
      row={row}
      kind={call.kind}
      label={row.name}
      summary={<PathLabel path={call.filePath} cwd={cwd} />}
      extra={
        <span
          className="flex shrink-0 gap-1.5 font-mono text-meta tabular"
          title={`${added} added, ${removed} removed`}
        >
          <span className="sr-only">
            {added} added, {removed} removed
          </span>
          {added > 0 && (
            <span aria-hidden className="text-st-ok-ink">
              +{added}
            </span>
          )}
          {removed > 0 && (
            <span aria-hidden className="text-st-err-ink">
              −{removed}
            </span>
          )}
        </span>
      }
      status={<ToolState row={row} />}
      defaultOpen
    >
      <div className="flex h-8 items-center justify-between gap-3 border-line border-b pr-1.5 pl-3">
        <span className="truncate text-meta text-text-2">{note}</span>
        <LayoutToggle />
      </div>
      {row.result?.isError && <ResultText text={stripAnsi(row.result.text)} tone="error" />}
      <DiffView
        id={row.id}
        hunks={hunks}
        lang={langFor(extensionOf(call.filePath))}
        gapLabel={(i) => `Edit ${i + 1}`}
      />
    </Card>
  );
}

function LayoutToggle() {
  const layout = usePreference(diffLayoutPreference);
  const thumb = useSegmentThumb();
  return (
    <div role="radiogroup" aria-label="Diff layout" className="flex rounded-control bg-bg-2 p-0.5">
      {DIFF_LAYOUTS.map((option) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={layout === option}
          onClick={(e) => {
            thumb.pick(e);
            diffLayoutPreference.set(option);
          }}
          className={cx(
            'relative h-5 rounded-chip px-2 text-meta capitalize transition-colors duration-fast touch:h-11 touch:min-w-11',
            layout === option ? 'text-text-1' : 'text-text-3 hover:text-text-1',
          )}
        >
          {layout === option && (
            <SegmentThumb
              layoutId={thumb.layoutId}
              byKeyboard={thumb.byKeyboard}
              className="bg-bg-1"
            />
          )}
          <span className="relative">{option}</span>
        </button>
      ))}
    </div>
  );
}

// Read, Grep, Glob, WebFetch, WebSearch: compact chips that open a preview

function ChipCard({
  row,
  cwd,
  call,
}: CardProps & {
  call: CallOf<'read'> | CallOf<'grep'> | CallOf<'glob'> | CallOf<'fetch'> | CallOf<'search'>;
}) {
  const result = row.result;
  const failed = result?.isError ?? false;
  const glitch = useGlitch(row);
  const [open, toggle] = useStickyFlag(row.id, false);
  const bodyId = useId();
  const Icon = FAMILY_ICON[toolFamily(row.name)];

  let target: ReactNode;
  let count: string | null = null;
  let href: string | null = null;
  switch (call.kind) {
    case 'read':
      target = <PathLabel path={call.filePath} cwd={cwd} />;
      if (result && !failed) count = readExtent(result.text);
      break;
    case 'grep':
    case 'glob': {
      const where = call.kind === 'grep' ? (call.glob ?? call.path) : call.path;
      const rel = where ? pathParts(where, cwd) : null;
      target = (
        <span className="flex min-w-0 gap-1.5 font-mono">
          <span className="min-w-0 truncate text-text-1">{call.pattern}</span>
          {rel && where !== cwd && (
            <span className="min-w-0 truncate text-text-3">in {rel.dir + rel.base}</span>
          )}
        </span>
      );
      if (result && !failed)
        count = call.kind === 'grep' ? grepCount(result.text) : globCount(result.text);
      break;
    }
    case 'fetch': {
      const parts = urlParts(call.url);
      href = parts ? call.url : null;
      target = parts ? (
        <span className="flex min-w-0 font-mono" title={call.url}>
          <span className="shrink-0 text-text-1">{parts.host}</span>
          <span className="min-w-0 truncate text-text-3">{parts.rest}</span>
        </span>
      ) : (
        <span className="min-w-0 truncate font-mono text-text-1">{call.url}</span>
      );
      break;
    }
    case 'search': {
      target = <span className="min-w-0 truncate text-text-1">“{call.query}”</span>;
      const links = result && !failed ? urlsIn(result.text).length : 0;
      if (links > 0) count = countOf(links, 'link');
      break;
    }
  }

  return (
    <div
      data-tool={row.name}
      data-tool-kind={call.kind}
      data-state={result === null ? 'running' : failed ? 'error' : 'done'}
      data-open={open ? '' : undefined}
      className="flex min-w-0 flex-col items-start"
    >
      <div
        className={cx(
          'tool-chip flex h-7 max-w-full min-w-0 items-center overflow-hidden rounded-chip border border-line bg-bg-1 text-label touch:h-auto',
          glitch,
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          disabled={result === null}
          onClick={toggle}
          className="tool-head flex h-full min-w-0 items-center touch:min-h-11 gap-2 pr-2 pl-2 text-left disabled:cursor-default"
        >
          <Icon aria-hidden className="size-3.5 shrink-0 text-text-3" strokeWidth={1.5} />
          <span className="shrink-0 text-text-2">{row.name}</span>
          {target}
          {count && <span className="shrink-0 text-meta tabular text-text-2">{count}</span>}
          <span className="flex shrink-0 items-center">
            <ToolState row={row} />
          </span>
        </button>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Open ${urlParts(href)?.host ?? 'link'}`}
            className="flex h-full shrink-0 items-center gap-1 border-line border-l px-1.5 text-text-3 touch:min-h-11 touch:min-w-11 touch:justify-center transition-colors duration-fast hover:bg-bg-2 hover:text-text-1 max-md:px-2.5 max-md:text-meta"
          >
            <ExternalLink aria-hidden className="size-3" strokeWidth={1.75} />
            {/* Phones show the word (DESIGN.md §11). */}
            <span aria-hidden className="hidden max-md:inline">
              Open
            </span>
          </a>
        )}
      </div>
      {open && result && (
        <div
          id={bodyId}
          className="msg-fade mt-1 w-full overflow-hidden rounded-control border border-line bg-bg-1"
        >
          <ChipPreview call={call} text={result.text} failed={failed} cwd={cwd} />
        </div>
      )}
    </div>
  );
}

function ChipPreview({
  call,
  text,
  failed,
  cwd,
}: {
  call: CallOf<'read'> | CallOf<'grep'> | CallOf<'glob'> | CallOf<'fetch'> | CallOf<'search'>;
  text: string;
  failed: boolean;
  cwd: string | undefined;
}) {
  if (failed) return <ResultText text={stripAnsi(text)} tone="error" />;
  switch (call.kind) {
    case 'read': {
      const lines = numberedLines(text);
      if (!lines) return <ResultText text={text} />;
      return (
        <CodeLines
          lines={lines.slice(0, PREVIEW_LINES).map((l) => l.text)}
          lang={extensionOf(call.filePath)}
          firstNo={lines[0]?.no ?? 1}
          more={Math.max(0, lines.length - PREVIEW_LINES)}
        />
      );
    }
    case 'glob':
    case 'grep': {
      const paths =
        call.kind === 'glob' || /^Found \d+ files?\n/.test(text) ? listedPaths(text) : null;
      const shown = (paths ?? text.split('\n')).slice(0, PREVIEW_LINES);
      const total = paths?.length ?? text.split('\n').length;
      return (
        <ResultText
          text={`${shown.map((p) => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p)).join('\n')}${total > PREVIEW_LINES ? `\n… ${total - PREVIEW_LINES} more` : ''}`}
        />
      );
    }
    case 'fetch':
      return (
        <div className="space-y-2 px-3 py-2">
          {call.prompt && <p className="text-meta text-text-2">{call.prompt}</p>}
          <Markdown className="md-sm" text={text.slice(0, MAX_RESULT_CHARS)} />
        </div>
      );
    case 'search': {
      const links = urlsIn(text);
      return (
        <div className="space-y-2 px-3 py-2">
          {links.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {links.map((url) => (
                <li key={url} className="min-w-0 max-w-full">
                  <UrlChip url={url} />
                </li>
              ))}
            </ul>
          )}
          <p className="line-clamp-6 whitespace-pre-wrap break-words text-body-sm text-text-2">
            {text
              .replace(/^Links: \[.*\]$/m, '')
              .replace(/\n{3,}/g, '\n\n')
              .trim()}
          </p>
        </div>
      );
    }
  }
}

function UrlChip({ url }: { url: string }) {
  const parts = urlParts(url);
  if (!parts) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      title={url}
      className="flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-chip border border-line bg-bg-2 px-2 font-mono text-meta transition-colors duration-fast hover:border-line-strong touch:h-11"
    >
      <Globe aria-hidden className="size-3 shrink-0 text-text-3" strokeWidth={1.5} />
      <span className="shrink-0 text-text-1">{parts.host}</span>
      <span className="min-w-0 truncate text-text-3">{parts.rest}</span>
    </a>
  );
}

// TodoWrite

function TodoCard({
  row,
  call,
  draw,
  previous,
}: CardProps & {
  call: CallOf<'todo'>;
  draw: boolean;
  previous: readonly { content: string; status: TodoStatus }[] | null;
}) {
  const done = call.todos.filter((t) => t.status === 'completed').length;
  const total = call.todos.length;
  const current = call.todos.find((t) => t.status === 'in_progress');
  const wasDone = new Set(
    (previous ?? []).filter((t) => t.status === 'completed').map((t) => t.content),
  );
  return (
    <Card
      row={row}
      kind="todo"
      label="Todos"
      summary={
        <span className="min-w-0 truncate text-text-3">
          {current ? (current.activeForm ?? current.content) : total === 0 ? 'Cleared' : ''}
        </span>
      }
      extra={
        total > 0 && (
          <span className="flex shrink-0 items-center gap-2 text-meta tabular text-text-2">
            <span aria-hidden className="h-1 w-10 overflow-hidden rounded-full bg-line-strong">
              <span
                className="todo-progress block h-full origin-left rounded-full bg-st-ok"
                style={{ transform: `scaleX(${done / total})` }}
              />
            </span>
            {done}/{total}
          </span>
        )
      }
      status={null}
      defaultOpen
    >
      <ul className="space-y-1 px-3 py-2" aria-label={`${done} of ${total} done`}>
        {call.todos.map((todo, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: todo text can repeat
            key={i}
            data-todo={todo.status}
            className="flex items-start gap-2 text-body-sm"
          >
            <TodoMark status={todo.status} draw={draw && !wasDone.has(todo.content)} />
            <span
              className={cx(
                'min-w-0 break-words',
                todo.status === 'completed' && 'text-text-2 line-through decoration-text-3',
                todo.status === 'in_progress' && 'font-medium text-text-1',
                todo.status === 'pending' && 'text-text-2',
              )}
            >
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TodoMark({ status, draw }: { status: TodoStatus; draw: boolean }) {
  const label =
    status === 'completed' ? 'done' : status === 'in_progress' ? 'in progress' : 'to do';
  // The check draws in on a newly finished item.
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      className="mt-0.5 size-4 shrink-0"
      fill="none"
      strokeWidth={1.5}
    >
      {status === 'completed' ? (
        <DrawnCheck draw={draw} />
      ) : status === 'in_progress' ? (
        <>
          <circle cx="8" cy="8" r="6.5" className="stroke-st-work" />
          <circle cx="8" cy="8" r="2.5" className="fill-st-work" />
        </>
      ) : (
        <circle cx="8" cy="8" r="6.5" className="stroke-line-strong" />
      )}
    </svg>
  );
}

// Task / subagent

function TaskCard({ row, call }: CardProps & { call: CallOf<'task'> }) {
  const [promptOpen, togglePrompt] = useStickyFlag(`${row.id}:prompt`, false);
  const long = call.prompt.length > 280 || call.prompt.split('\n').length > 4;
  return (
    <Card
      row={row}
      kind="task"
      label={row.name}
      summary={<span className="min-w-0 truncate text-text-2">{call.description}</span>}
      extra={
        call.agent ? (
          <span className="shrink-0 rounded-chip border border-line px-1.5 text-meta text-text-2">
            {call.agent}
          </span>
        ) : null
      }
      status={<ToolState row={row} />}
      defaultOpen={false}
    >
      <div className="task-thread my-2 mr-3 ml-[17px] space-y-2 border-l pl-4">
        {call.prompt && (
          <div className="rounded-control border border-line bg-bg-2 px-3 py-2 text-body-sm text-text-2">
            <p
              className={cx(
                'whitespace-pre-wrap break-words',
                long && !promptOpen && 'line-clamp-4',
              )}
            >
              {call.prompt}
            </p>
            {long && (
              <button
                type="button"
                onClick={togglePrompt}
                className="mt-1 text-label text-text-3 hover:text-text-1"
              >
                {promptOpen ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        )}
        {row.result === null ? (
          <p className="text-body-sm text-text-2">
            <Shimmer>Subagent working…</Shimmer>
          </p>
        ) : row.result.isError ? (
          <ResultText text={stripAnsi(row.result.text)} tone="error" />
        ) : (
          <Markdown className="md-sm" text={row.result.text.slice(0, MAX_RESULT_CHARS)} />
        )}
      </div>
    </Card>
  );
}

// Anything else: the input as JSON

/** The first short string field of an input, as a summary for tools we don't know. */
function firstText(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim() !== '') return value.split('\n')[0] ?? '';
  }
  return '';
}

function OtherCard({ row, cwd }: CardProps) {
  const json = useMemo(() => prettyJson(row.input), [row.input]);
  const lines = json.split('\n');
  return (
    <Card
      row={row}
      kind="other"
      label={toolLabel(row.name)}
      summary={
        <span className="min-w-0 truncate font-mono text-text-3">
          {toolSummary(row.name, row.input, cwd) || firstText(row.input)}
        </span>
      }
      status={<ToolState row={row} />}
      defaultOpen={row.result?.isError ?? false}
    >
      <CodeLines
        lines={lines.slice(0, PREVIEW_LINES)}
        lang="json"
        firstNo={null}
        more={Math.max(0, lines.length - PREVIEW_LINES)}
      />
      {row.result && (
        <div className="border-line border-t">
          <ResultText
            text={stripAnsi(row.result.text)}
            tone={row.result.isError ? 'error' : undefined}
          />
        </div>
      )}
    </Card>
  );
}

/** A label that shimmers while its work runs; the sweep pauses off screen. */
function Shimmer({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const onScreen = useInView(ref);
  return (
    <span
      ref={ref}
      data-shimmer
      data-offscreen={!onScreen || undefined}
      className="shimmer relative inline-block overflow-hidden"
    >
      {children}
    </span>
  );
}
