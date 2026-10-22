import type { StreamId, Terminal, UiAction } from '@c-board/protocol';
import {
  AppWindow,
  ChevronDown,
  ChevronUp,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  LayoutGrid,
  Maximize2,
  Minimize2,
  RotateCcw,
  Search,
  Square,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { attentionOpen } from '../attention/attention.js';
import { selectWindow, useBoard, useBoardClient, useBoardShallow } from '../data/index.js';
import type { BoardStoreState } from '../data/store.js';
import { ColumnHeading } from '../focus/ColumnHeading.js';
import { MORPH_SETTLE_MS } from '../focus/shared.js';
import { laneView, selectLaneExecution, terminalName } from '../lanes/lane.js';
import { tabGlide } from '../motion.js';
import { usePreference } from '../prefs.js';
import { reveal, useMasked, useRedactOn } from '../redact/reveal.js';
import { isTypingTarget } from '../shell/railNav.js';
import { buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { ExitBadge } from '../ui/ExitBadge.js';
import { IconButton } from '../ui/IconButton.js';
import { Kbd } from '../ui/Kbd.js';
import { StatusDot } from '../ui/StatusDot.js';
import { Tooltip } from '../ui/Tooltip.js';
import {
  actionErrorText,
  gridTerminals,
  paneKind,
  resolveActive,
  type StackLayout,
  stackLayoutPreference,
  stackOrder,
  stepTab,
} from './stack.js';
import { terminalTarget, useTerminalTarget } from './target.js';
import type { XtermController } from './XtermView.js';

// xterm and its renderers load with the first focus view, not with the overview.
const XtermView = lazy(() => import('./XtermView.js'));

export interface TerminalStackProps {
  projectId: string;
  terminals: readonly Terminal[];
  /** The stack covers the whole focus view. Undefined where maximizing makes no sense. */
  maximized?: boolean;
  onMaximizedChange?: (maximized: boolean) => void;
  /** Hold the renderers back until the pod-to-focus morph has settled, so it keeps its frames. */
  deferRenderers?: boolean;
}

/**
 * The focus view's terminal stack, DESIGN.md §4.6: every terminal of the project mirrored in
 * xterm, as tabs or a 2×2 grid, with a toolbar and a command line for the active one. Only
 * visible panes keep a renderer; hidden ones keep their output in the client's stream history.
 */
export function TerminalStack({
  projectId,
  terminals,
  maximized,
  onMaximizedChange,
  deferRenderers = false,
}: TerminalStackProps) {
  const [renderersReady, setRenderersReady] = useState(!deferRenderers);
  useEffect(() => {
    if (renderersReady) return;
    const timer = setTimeout(() => setRenderersReady(true), MORPH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [renderersReady]);
  const ordered = useMemo(() => stackOrder(terminals), [terminals]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [byKeyboard, setByKeyboard] = useState(false);
  // A terminal picked in ⌘K opens here once.
  const target = useTerminalTarget(projectId);
  useEffect(() => {
    if (target === null || !ordered.some((t) => t.id === target)) return;
    setChosen(target);
    terminalTarget.set(null);
  }, [target, ordered]);
  const interactiveIds = useBoard(selectInteractiveIds(ordered));
  const interactive = useMemo(() => new Set(interactiveIds.split('\n')), [interactiveIds]);
  const activeId = resolveActive(ordered, chosen, (id) => !interactive.has(id));
  const active = ordered.find((t) => t.id === activeId) ?? null;
  const layout = usePreference(stackLayoutPreference);
  const grid = layout === 'grid' && ordered.length > 1;
  const panes = grid ? gridTerminals(ordered, activeId) : active ? [active] : [];
  const controllers = useRef(new Map<string, XtermController>());
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeController = useCallback(
    () => (activeId === null ? null : (controllers.current.get(activeId) ?? null)),
    [activeId],
  );

  useRetainedStreams(ordered);

  useEffect(() => {
    if (!maximized || !onMaximizedChange) return;
    // Capture phase: Escape restores the stack before the focus view would close.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || attentionOpen.get() === 'open') return;
      event.preventDefault();
      onMaximizedChange(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [maximized, onMaximizedChange]);

  const onTabKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = stepTab(ordered, activeId, step);
    if (next === null) return;
    setByKeyboard(true);
    setChosen(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <div data-terminal-stack={projectId} className="flex h-full min-h-0 flex-col gap-3">
      <ColumnHeading
        className=""
        meta={ordered.length > 0 ? ordered.length : undefined}
        actions={
          <>
            {ordered.length > 1 && <LayoutToggle layout={layout} />}
            {onMaximizedChange && (
              <IconButton
                size="sm"
                label={maximized ? 'Restore terminals' : 'Maximize terminals'}
                aria-pressed={maximized}
                icon={
                  maximized ? (
                    <Minimize2 className="size-4" strokeWidth={1.5} />
                  ) : (
                    <Maximize2 className="size-4" strokeWidth={1.5} />
                  )
                }
                onClick={() => onMaximizedChange(!maximized)}
              />
            )}
          </>
        }
      >
        Terminals
      </ColumnHeading>

      {ordered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-control border border-line border-dashed px-6 text-center">
          <p className="text-body-sm text-text-2">No terminals</p>
          <p className="text-meta text-text-2">Terminals opened in the editor show up here.</p>
        </div>
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Terminals"
            onKeyDown={onTabKey}
            className="-mx-1 flex min-w-0 shrink-0 gap-1 overflow-x-auto px-1 pb-0.5"
          >
            {ordered.map((terminal) => (
              <StackTab
                key={terminal.id}
                terminal={terminal}
                projectId={projectId}
                selected={terminal.id === activeId}
                byKeyboard={byKeyboard}
                tabRef={(el) => {
                  if (el) tabRefs.current.set(terminal.id, el);
                  else tabRefs.current.delete(terminal.id);
                }}
                onSelect={(viaKeyboard) => {
                  setByKeyboard(viaKeyboard);
                  setChosen(terminal.id);
                }}
              />
            ))}
          </div>

          <div
            role="tabpanel"
            aria-label={active ? `Terminal ${active.name}` : 'Terminal'}
            className={cx(
              'grid min-h-0 flex-1 gap-2',
              panes.length > 2 && 'grid-cols-2 grid-rows-2',
              panes.length === 2 && 'grid-rows-2',
            )}
          >
            {panes.map((terminal, i) => (
              <Pane
                key={terminal.id}
                terminal={terminal}
                inGrid={grid}
                active={terminal.id === activeId}
                wide={panes.length === 3 && i === 2}
                renderer={renderersReady}
                onActivate={() => setChosen(terminal.id)}
                onController={(c) => {
                  if (c) controllers.current.set(terminal.id, c);
                  else controllers.current.delete(terminal.id);
                }}
              />
            ))}
          </div>

          {active && (
            <ActiveControls key={active.id} terminal={active} controller={activeController} />
          )}
        </>
      )}
    </div>
  );
}

/** Keeps each terminal's stream open while the stack is mounted, so switching panes replays. */
function useRetainedStreams(terminals: readonly Terminal[]) {
  const client = useBoardClient();
  const key = terminals.map((t) => t.id).join('\n');
  useEffect(() => {
    if (key === '') return;
    const stops = key
      .split('\n')
      .map((id) => client.subscribeStream(`term:${id}` as StreamId, () => {}));
    return () => {
      for (const stop of stops) stop();
    };
  }, [client, key]);
}

/** The ids of terminals showing an interactive app's pane, as one string so it compares by value. */
const selectInteractiveIds =
  (terminals: readonly Terminal[]) =>
  (s: BoardStoreState): string =>
    terminals
      .filter((t) => {
        const execution = selectLaneExecution(t)(s);
        return paneKind(execution.id === null ? null : execution, t) === 'interactive';
      })
      .map((t) => t.id)
      .join('\n');

function useTerminalView(terminal: Terminal) {
  const execution = useBoardShallow(selectLaneExecution(terminal));
  return { execution, view: laneView(terminal, execution) };
}

function LayoutToggle({ layout }: { layout: StackLayout }) {
  const next: StackLayout = layout === 'grid' ? 'tabs' : 'grid';
  return (
    <IconButton
      size="sm"
      label={layout === 'grid' ? 'Show one terminal' : 'Show up to four terminals'}
      aria-pressed={layout === 'grid'}
      icon={
        layout === 'grid' ? (
          <Square className="size-4" strokeWidth={1.5} />
        ) : (
          <LayoutGrid className="size-4" strokeWidth={1.5} />
        )
      }
      onClick={() => stackLayoutPreference.set(next)}
    />
  );
}

function StackTab({
  terminal,
  projectId,
  selected,
  byKeyboard,
  tabRef,
  onSelect,
}: {
  terminal: Terminal;
  projectId: string;
  selected: boolean;
  /** The selection came from the keyboard: the indicator snaps instead of gliding. */
  byKeyboard: boolean;
  tabRef: (el: HTMLButtonElement | null) => void;
  onSelect: (byKeyboard: boolean) => void;
}) {
  const { view } = useTerminalView(terminal);
  const closed = terminal.state === 'closed';
  return (
    <button
      ref={tabRef}
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={view.label}
      title={view.command ? `${terminalName(terminal)}: ${view.command}` : terminalName(terminal)}
      tabIndex={selected ? 0 : -1}
      data-tab={terminal.id}
      // detail 0: Enter or Space, not a pointer.
      onClick={(e) => onSelect(e.detail === 0)}
      className={cx(
        'relative flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-control px-3 text-label transition-colors duration-150',
        selected ? 'text-text-1' : 'text-text-3 hover:text-text-2',
        closed && 'opacity-70',
      )}
    >
      {selected && (
        <motion.span
          layoutId={`terminal-tab-${projectId}`}
          transition={tabGlide(byKeyboard)}
          aria-hidden
          className="absolute inset-0 rounded-control border border-line bg-bg-2 shadow-raised"
        />
      )}
      <StatusDot tone={view.tone} label={view.label} className="relative" />
      <span className="relative truncate">{terminalName(terminal)}</span>
      <AnimatePresence initial={false}>
        {view.exit && view.exit.code !== 0 && (
          <ExitBadge key={view.exit.key} code={view.exit.code} className="relative -mr-1" />
        )}
      </AnimatePresence>
    </button>
  );
}

function Pane({
  terminal,
  inGrid,
  active,
  wide,
  renderer,
  onActivate,
  onController,
}: {
  terminal: Terminal;
  inGrid: boolean;
  active: boolean;
  wide: boolean;
  renderer: boolean;
  onActivate: () => void;
  onController: (controller: XtermController | null) => void;
}) {
  const { execution, view } = useTerminalView(terminal);
  const kind = paneKind(execution.id === null ? null : execution, terminal);
  const masked = useMasked(`term:${terminal.id}`);
  return (
    <section
      aria-label={terminalName(terminal)}
      data-pane={terminal.id}
      data-active={(inGrid && active) || undefined}
      onPointerDown={inGrid ? onActivate : undefined}
      onFocusCapture={inGrid ? onActivate : undefined}
      className={cx(
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-control border bg-bg-0 transition-[border-color,box-shadow] duration-150',
        inGrid && active ? 'border-line-strong shadow-raised' : 'border-line',
        wide && 'col-span-2',
      )}
    >
      {inGrid && (
        <header className="flex h-7 shrink-0 items-center gap-1.5 border-line border-b px-3 text-label">
          <StatusDot tone={view.tone} label={view.label} />
          <span
            title={terminalName(terminal)}
            className={cx('max-w-[60%] shrink-0 truncate', active ? 'text-text-1' : 'text-text-2')}
          >
            {terminalName(terminal)}
          </span>
          {view.command && (
            <span className="min-w-0 truncate font-mono text-meta text-text-2" title={view.command}>
              {view.command}
            </span>
          )}
          <span className="ml-auto flex">
            <AnimatePresence initial={false}>
              {view.exit && <ExitBadge key={view.exit.key} code={view.exit.code} />}
            </AnimatePresence>
          </span>
        </header>
      )}
      {kind === 'interactive' ? (
        <InteractiveCard terminal={terminal} command={view.command} compact={inGrid} />
      ) : (
        <div className="min-h-0 flex-1 py-2 pl-3 pr-1">
          {renderer && (
            <Suspense fallback={null}>
              <XtermView
                terminalId={terminal.id}
                label={`Output of ${terminalName(terminal)}`}
                redact={masked}
                onController={onController}
              />
            </Suspense>
          )}
        </div>
      )}
    </section>
  );
}

function useEditorName(terminal: Terminal): string {
  return useBoard((s) => selectWindow(terminal.windowId)(s)?.appName) || 'the editor';
}

function useTerminalAction() {
  const client = useBoardClient();
  return async (action: UiAction): Promise<boolean> => {
    const result = await client.action(action);
    if (!result.ok) toast.error(actionErrorText(result.error));
    return result.ok;
  };
}

/**
 * Alt-screen apps can't be mirrored faithfully; point to the editor instead. A grid tile gets
 * the short version (its header already names the command), and never overflows its header.
 */
function InteractiveCard({
  terminal,
  command,
  compact,
}: {
  terminal: Terminal;
  command: string | null;
  compact: boolean;
}) {
  const editor = useEditorName(terminal);
  const act = useTerminalAction();
  const claude = command !== null && /^claude(\s|$)/.test(command);
  return (
    <div
      data-interactive={terminal.id}
      className={cx(
        'flex min-h-0 flex-1 flex-col items-center justify-center-safe overflow-y-auto text-center',
        compact ? 'gap-2 px-3 py-2' : 'gap-3 px-6 py-4',
      )}
    >
      <AppWindow aria-hidden className="size-5 shrink-0 text-text-3" strokeWidth={1.5} />
      {compact ? (
        <p className="font-medium text-body-sm text-text-1">Interactive app</p>
      ) : (
        <div className="flex max-w-72 flex-col gap-1">
          <p className="font-medium text-body-sm text-text-1">Interactive app, open in {editor}</p>
          <p className="text-meta text-text-2">
            {command ? <span className="font-mono text-text-1">{command}</span> : 'This program'}{' '}
            draws full screen, which a mirror can't show faithfully.
            {claude && ' Its conversation is in the Claude panel.'}
          </p>
        </div>
      )}
      <button
        type="button"
        title={`Show in ${editor}`}
        className={cx(buttonClass('secondary', 'sm'), 'max-w-full shrink-0')}
        onClick={() => act({ kind: 'terminal.focus', terminalId: terminal.id })}
      >
        <ExternalLink aria-hidden className="size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="truncate">Show in {editor}</span>
      </button>
    </div>
  );
}

/** Toolbar, search and command line for the active terminal. */
function ActiveControls({
  terminal,
  controller,
}: {
  terminal: Terminal;
  controller: () => XtermController | null;
}) {
  const { execution, view } = useTerminalView(terminal);
  const editor = useEditorName(terminal);
  const act = useTerminalAction();
  const open = terminal.state === 'open';
  const [searching, setSearching] = useState(false);
  const redactOn = useRedactOn();
  const masked = useMasked(`term:${terminal.id}`);
  const interactive =
    paneKind(execution.id === null ? null : execution, terminal) === 'interactive';

  const interrupt = () => act({ kind: 'terminal.interrupt', terminalId: terminal.id });
  const rerunnable = open && !view.running && execution.id !== null && Boolean(view.command);

  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-0.5">
        <Tooltip content="Send Ctrl+C" shortcut="⌃C">
          <button
            type="button"
            aria-label="Send Ctrl+C"
            disabled={!open}
            onClick={interrupt}
            className={cx(buttonClass('ghost', 'sm'), 'px-2 font-mono')}
          >
            ⌃C
          </button>
        </Tooltip>
        <IconButton
          size="sm"
          label={view.command ? `Re-run ${view.command}` : 'Re-run'}
          disabled={!rerunnable}
          icon={<RotateCcw className="size-4" strokeWidth={1.5} />}
          onClick={() => execution.id && act({ kind: 'terminal.rerun', execId: execution.id })}
        />
        <IconButton
          size="sm"
          label={`Show in ${editor}`}
          disabled={!open}
          icon={<ExternalLink className="size-4" strokeWidth={1.5} />}
          onClick={() => act({ kind: 'terminal.focus', terminalId: terminal.id })}
        />
        <span aria-hidden className="mx-1 h-4 w-px bg-line" />
        <IconButton
          size="sm"
          label="Search output"
          aria-pressed={searching}
          disabled={interactive}
          icon={<Search className="size-4" strokeWidth={1.5} />}
          onClick={() => setSearching((s) => !s)}
        />
        <IconButton
          size="sm"
          label="Clear view"
          disabled={interactive}
          icon={<Eraser className="size-4" strokeWidth={1.5} />}
          onClick={() => controller()?.clear()}
        />
        {redactOn && (
          <IconButton
            size="sm"
            label={masked ? 'Reveal secrets' : 'Hide secrets'}
            aria-pressed={!masked}
            disabled={interactive}
            icon={
              masked ? (
                <EyeOff className="size-4" strokeWidth={1.5} />
              ) : (
                <Eye className="size-4" strokeWidth={1.5} />
              )
            }
            onClick={() => reveal.toggle(`term:${terminal.id}`)}
          />
        )}
        <span className="ml-auto min-w-0 truncate pl-2 font-mono text-meta text-text-2">
          {view.running ? 'running' : view.exit ? `exit ${view.exit.code}` : null}
        </span>
      </div>
      {searching && !interactive && (
        <SearchBar controller={controller} onClose={() => setSearching(false)} />
      )}
      <CommandLine
        terminal={terminal}
        running={view.running ? view.command : null}
        onInterrupt={interrupt}
      />
    </div>
  );
}

function SearchBar({
  controller,
  onClose,
}: {
  controller: () => XtermController | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  useEffect(() => controller()?.onSearchResults(setResults), [controller]);
  const find = (direction: 'next' | 'previous') => {
    if (query !== '') controller()?.find(query, direction);
  };
  const close = () => {
    controller()?.clearSearch();
    onClose();
  };
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-control border border-line bg-bg-0 pr-1 pl-3 focus-within:border-line-strong focus-within:shadow-[var(--focus-ring)]">
      <Search aria-hidden className="size-3.5 shrink-0 text-text-3" strokeWidth={1.5} />
      <input
        // biome-ignore lint/a11y/noAutofocus: opened on purpose from the toolbar.
        autoFocus
        type="search"
        aria-label="Search terminal output"
        placeholder="Search output"
        value={query}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value === '') controller()?.clearSearch();
          else controller()?.find(e.target.value, 'next');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            find(e.shiftKey ? 'previous' : 'next');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        className="terminal-search h-8 min-w-0 flex-1 bg-transparent font-mono text-label text-text-1 outline-none placeholder:text-text-3 focus-visible:shadow-none"
      />
      {query !== '' && results && (
        <span aria-live="polite" className="shrink-0 px-1 font-mono text-meta text-text-2 tabular">
          {results.count === 0 ? 'No matches' : `${results.index + 1}/${results.count}`}
        </span>
      )}
      <IconButton
        size="sm"
        label="Previous match"
        shortcut="⇧↵"
        icon={<ChevronUp className="size-4" strokeWidth={1.5} />}
        onClick={() => find('previous')}
      />
      <IconButton
        size="sm"
        label="Next match"
        shortcut="↵"
        icon={<ChevronDown className="size-4" strokeWidth={1.5} />}
        onClick={() => find('next')}
      />
      <IconButton
        size="sm"
        label="Close search"
        shortcut="Esc"
        icon={<X className="size-4" strokeWidth={1.5} />}
        onClick={close}
      />
    </div>
  );
}

const HISTORY_MAX = 50;

/**
 * Sends a line to the terminal (`cmd.sendText`). At the prompt it runs as a command; while a
 * program runs, it is that program's input. ↑/↓ walk this view's history; ⌃C interrupts.
 */
function CommandLine({
  terminal,
  running,
  onInterrupt,
}: {
  terminal: Terminal;
  running: string | null;
  onInterrupt: () => void;
}) {
  const act = useTerminalAction();
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const history = useRef<string[]>([]);
  const cursor = useRef<number | null>(null);
  const open = terminal.state === 'open';

  const submit = async () => {
    if (!open || sending) return;
    setSending(true);
    const text = value;
    const ok = await act({
      kind: 'terminal.sendText',
      terminalId: terminal.id,
      text,
      execute: true,
    });
    setSending(false);
    if (!ok) return;
    if (text.trim() !== '' && history.current.at(-1) !== text) {
      history.current = [...history.current, text].slice(-HISTORY_MAX);
    }
    cursor.current = null;
    setValue('');
  };

  const walk = (step: -1 | 1) => {
    const items = history.current;
    if (items.length === 0) return;
    const from = cursor.current ?? items.length;
    const next = Math.min(items.length, Math.max(0, from + step));
    cursor.current = next === items.length ? null : next;
    setValue(next === items.length ? '' : (items[next] ?? ''));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className={cx(
        'flex min-w-0 items-center gap-2 rounded-control border border-line bg-bg-0 pr-1.5 pl-3 transition-colors duration-150 focus-within:border-line-strong focus-within:shadow-[var(--focus-ring)]',
        !open && 'opacity-60',
      )}
    >
      <span aria-hidden className="font-mono text-label text-text-3">
        {running ? '›' : '$'}
      </span>
      <input
        aria-label={`Send to ${terminalName(terminal)}`}
        data-command-line={terminal.id}
        disabled={!open}
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        placeholder={
          !open
            ? 'Terminal closed'
            : running
              ? `Input for ${running}`
              : `Run in ${terminalName(terminal)}`
        }
        onChange={(e) => {
          setValue(e.target.value);
          cursor.current = null;
        }}
        onKeyDown={(e) => {
          if (e.key === 'c' && e.ctrlKey && !e.metaKey && !e.altKey) {
            const input = e.currentTarget;
            if (input.selectionStart === input.selectionEnd) {
              e.preventDefault();
              setValue('');
              onInterrupt();
            }
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            walk(e.key === 'ArrowUp' ? -1 : 1);
          }
        }}
        className="h-9 min-w-0 flex-1 bg-transparent font-mono text-label text-text-1 outline-none placeholder:text-text-3 focus-visible:shadow-none disabled:cursor-not-allowed"
      />
      <Kbd className="text-text-3">{sending ? '…' : '↵'}</Kbd>
    </form>
  );
}
