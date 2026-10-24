import {
  accentIndexForProject,
  type LibraryEntry,
  type LibraryResponse,
  type PermissionMode,
} from '@c-board/protocol';
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import {
  ArrowLeft,
  Check,
  CornerDownLeft,
  Cpu,
  ExternalLink,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  MessageSquarePlus,
  Search,
  ShieldCheck,
  SquareTerminal,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link, useLocation } from 'wouter';
import { Pill } from '../claude/Composer.js';
import {
  MODEL_OPTIONS,
  modelLabel,
  PERMISSION_OPTIONS,
  permissionLabel,
} from '../claude/composerModel.js';
import { useBoard, useBoardClient, useBoardStore } from '../data/index.js';
import { dur, ease, useMotionLevel } from '../motion.js';
import { editorName } from '../palette/commands.js';
import { highlightRuns } from '../palette/fuzzy.js';
import { createPreference, type KeyValueStorage, useMediaQuery, usePreference } from '../prefs.js';
import { projectHref, routes, sessionHref } from '../routes.js';
import { api } from '../settings/api.js';
import { useServerStatus } from '../settings/useServerStatus.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { NARROW_QUERY } from '../shell/prefs.js';
import { BOARD_TERMINALS_OFF, recentCommands, terminalHost } from '../terminal/newTerminal.js';
import { actionErrorText } from '../terminal/stack.js';
import { formatDateTime, formatWhen } from '../time.js';
import { SheetPanel } from '../ui/BottomSheet.js';
import { buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { Kbd } from '../ui/Kbd.js';
import { Skeleton } from '../ui/Skeleton.js';
import { Tooltip } from '../ui/Tooltip.js';
import { requestClose } from './closing.js';
import {
  entryProjectId,
  type LaunchChoice,
  type LaunchStep,
  launchBlocker,
  launchMemory,
  launchSummary,
  type PickerRow,
  pickerRows,
  runLaunch,
  withoutForgotten,
} from './launch.js';

// In memory only: a reload starts with the picker closed.
const memory: KeyValueStorage = { getItem: () => null, setItem: () => {} };

export const pickerOpen = createPreference<'open' | 'closed'>(
  'cboard.picker',
  ['open', 'closed'],
  'closed',
  memory,
);

/** ⌘O on macOS, Ctrl+O elsewhere. */
export function isPickerShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): boolean {
  return (
    event.key.toLowerCase() === 'o' &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

const close = () => pickerOpen.set('closed');
const NO_ENTRIES: readonly LibraryEntry[] = [];

const STEP_NAME: Record<LaunchStep['kind'], string> = {
  editor: 'The editor did not open',
  claude: 'The Claude session did not start',
  terminal: 'The terminal did not open',
};

/**
 * "Open project" (F25): a searchable list of the library's folders, then a launch sheet that opens
 * the chosen one in Cursor, starts a Claude session and a terminal, in any combination. A glass
 * modal like ⌘K on wide screens, a bottom sheet on phones.
 */
export function OpenProjectDialog() {
  const open = usePreference(pickerOpen) === 'open';
  const narrow = useMediaQuery(NARROW_QUERY);
  // Set when a launch moves focus to the focus view.
  const keepFocus = useRef(false);
  // The launch sheet handles Esc itself (back to the list) instead of closing.
  const onEscape = useRef<(() => boolean) | null>(null);

  useEffect(() => {
    // Capture: the shortcut works from inside a terminal too, and the browser's "Open file" stays shut.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!isPickerShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      pickerOpen.set(pickerOpen.get() === 'open' ? 'closed' : 'open');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => pickerOpen.set(next ? 'open' : 'closed')}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="palette-overlay fixed inset-0 z-50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: dur.fast, ease: ease.out } }}
                exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
              />
            </Dialog.Overlay>
            <Dialog.Content
              asChild
              forceMount
              aria-describedby={undefined}
              onOpenAutoFocus={() => {
                keepFocus.current = false;
              }}
              onEscapeKeyDown={(event) => {
                if (onEscape.current?.()) event.preventDefault();
              }}
              onCloseAutoFocus={(event) => {
                if (keepFocus.current) event.preventDefault();
              }}
            >
              {narrow ? (
                <SheetPanel
                  data-open-project
                  onDismiss={() => pickerOpen.set('closed')}
                  className="overflow-hidden"
                >
                  <Dialog.Title className="sr-only">Open project</Dialog.Title>
                  <PickerBody
                    keepFocus={() => {
                      keepFocus.current = true;
                    }}
                    onEscape={onEscape}
                  />
                </SheetPanel>
              ) : (
                <motion.div
                  data-open-project
                  className="palette fixed top-[12vh] left-1/2 z-50 flex max-h-[min(640px,80vh)] w-[min(600px,calc(100vw-32px))] flex-col overflow-hidden rounded-modal border border-line-strong shadow-raised outline-none"
                  style={{ x: '-50%' }}
                  initial={{ opacity: 0, scale: 0.96, filter: 'blur(4px)' }}
                  animate={{
                    opacity: 1,
                    scale: 1,
                    filter: 'blur(0px)',
                    transition: { duration: dur.fast, ease: ease.out },
                    transitionEnd: { filter: 'none' },
                  }}
                  exit={{
                    opacity: 0,
                    scale: 0.98,
                    transition: { duration: dur.fast, ease: ease.out },
                  }}
                >
                  <Dialog.Title className="sr-only">Open project</Dialog.Title>
                  <PickerBody
                    keepFocus={() => {
                      keepFocus.current = true;
                    }}
                    onEscape={onEscape}
                  />
                </motion.div>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

type Library =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: LibraryResponse };

function useLibrary(): Library {
  const [library, setLibrary] = useState<Library>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    api.library(controller.signal).then(
      (data) => setLibrary({ state: 'ready', data }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLibrary({
          state: 'error',
          message: error instanceof Error ? error.message : 'The library did not load',
        });
      },
    );
    return () => controller.abort();
  }, []);
  return library;
}

function PickerBody({
  keepFocus,
  onEscape,
}: {
  keepFocus: () => void;
  onEscape: RefObject<(() => boolean) | null>;
}) {
  const library = useLibrary();
  const [entry, setEntry] = useState<LibraryEntry | null>(null);
  const [query, setQuery] = useState('');
  const level = useMotionLevel();

  onEscape.current = () => {
    if (entry === null) return false;
    setEntry(null);
    return true;
  };

  // The two pages cross-fade with a touch of blur, so the swap reads as one surface changing.
  const page = {
    initial: level === 'off' ? false : { opacity: 0, filter: 'blur(2px)' },
    animate: {
      opacity: 1,
      filter: 'blur(0px)',
      transition: { duration: dur.fast, ease: ease.out },
      transitionEnd: { filter: 'none' },
    },
  } as const;

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {entry === null ? (
        <motion.div key="list" className="flex min-h-0 flex-1 flex-col" {...page}>
          <LibraryList library={library} query={query} onQuery={setQuery} onPick={setEntry} />
        </motion.div>
      ) : (
        <motion.div key={entry.path} className="flex min-h-0 flex-1 flex-col" {...page}>
          <LaunchSheet entry={entry} onBack={() => setEntry(null)} keepFocus={keepFocus} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function LibraryList({
  library,
  query,
  onQuery,
  onPick,
}: {
  library: Library;
  query: string;
  onQuery: (query: string) => void;
  onPick: (entry: LibraryEntry) => void;
}) {
  const projects = useBoard((s) => s.board.projects);
  const listed = library.state === 'ready' ? library.data.entries : NO_ENTRIES;
  const entries = useMemo(() => withoutForgotten(listed, projects), [listed, projects]);
  const rows = useMemo(() => pickerRows(entries, query, projects), [entries, query, projects]);
  const [selected, setSelected] = useState('');
  const value = rows.some((r) => r.entry.path === selected)
    ? selected
    : (rows[0]?.entry.path ?? '');
  const now = Date.now();
  const roots = library.state === 'ready' ? library.data.roots : [];
  const blocked = roots.filter((r) => r.error !== null);
  const multipleRoots = roots.length > 1;

  return (
    <Command
      label="Open project"
      shouldFilter={false}
      loop
      value={value}
      onValueChange={setSelected}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-line border-b px-4">
        <Search aria-hidden className="size-4 shrink-0 text-text-3" strokeWidth={1.5} />
        <Command.Input
          autoFocus
          value={query}
          onValueChange={onQuery}
          placeholder="Open a project folder"
          className="h-14 min-w-0 flex-1 bg-transparent text-body text-text-1 outline-none placeholder:text-text-3 focus-visible:shadow-none"
        />
        <Kbd className="shrink-0 max-sm:hidden">Esc</Kbd>
      </div>
      <Command.List className="palette-list min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {library.state === 'loading' && <ListSkeleton />}
        {library.state === 'error' && (
          <p role="alert" className="px-3 py-8 text-center text-body-sm text-st-err-ink">
            {library.message}
          </p>
        )}
        {library.state === 'ready' && roots.length === 0 && (
          <div
            data-library-empty
            className="flex flex-col items-center gap-2 px-6 py-10 text-center"
          >
            <FolderOpen aria-hidden className="size-6 text-text-3" strokeWidth={1.5} />
            <p className="font-medium text-body-sm text-text-1">No project folders yet</p>
            <p className="max-w-80 text-body-sm text-text-2">
              Add the folder that holds your projects, such as ~/Desktop, and its folders show up
              here.
            </p>
            <Link
              href={routes.settings}
              onClick={close}
              className={cx(buttonClass('secondary', 'sm'), 'mt-2')}
            >
              Add a folder in Settings
            </Link>
          </div>
        )}
        {library.state === 'ready' && roots.length > 0 && (
          <Command.Empty className="px-3 py-8 text-center text-body-sm text-text-2">
            {query.trim() ? `No folder matches “${query.trim()}”` : 'No folders in your library'}
          </Command.Empty>
        )}
        {rows.length > 0 && (
          <Command.Group
            heading={query.trim() ? 'Folders' : 'Recent first'}
            className="palette-group"
          >
            {rows.map((row) => (
              <FolderItem
                key={row.entry.path}
                row={row}
                now={now}
                showRoot={multipleRoots}
                onPick={onPick}
              />
            ))}
          </Command.Group>
        )}
      </Command.List>
      {blocked.length > 0 && (
        <ul className="shrink-0 border-line border-t px-4 py-2">
          {blocked.map((root) => (
            <li
              key={root.root}
              data-library-status={root.error}
              className="truncate text-meta text-st-wait-ink"
              title={root.message ?? undefined}
            >
              {root.root}: {root.message}
            </li>
          ))}
        </ul>
      )}
      <footer className="flex shrink-0 items-center gap-4 border-line border-t px-4 py-2 text-meta text-text-3 max-sm:hidden">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          to move
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>
            <CornerDownLeft aria-label="Enter" className="size-3" strokeWidth={1.5} />
          </Kbd>
          to choose
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>Esc</Kbd>
          to close
        </span>
      </footer>
    </Command>
  );
}

function FolderItem({
  row,
  now,
  showRoot,
  onPick,
}: {
  row: PickerRow;
  now: number;
  showRoot: boolean;
  onPick: (entry: LibraryEntry) => void;
}) {
  const { entry, indices, branch } = row;
  const avatar = { name: entry.name, accent: accentIndexForProject(entryProjectId(entry)) };
  const onBoard = useBoard((s) => entry.projectId !== null && !!s.board.projects[entry.projectId]);
  return (
    <Command.Item
      value={entry.path}
      onSelect={() => onPick(entry)}
      data-library-entry={entry.name}
      className="palette-item group/item"
    >
      <ProjectAvatar project={avatar} size="sm" />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="palette-label min-w-0 shrink truncate" title={entry.path}>
          {highlightRuns(entry.name, indices).map((run, i) =>
            run.hit ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
              <mark key={i}>{run.text}</mark>
            ) : (
              run.text
            ),
          )}
        </span>
        {showRoot && (
          <span className="min-w-0 shrink-[2] truncate text-meta text-text-3" title={entry.root}>
            {entry.root}
          </span>
        )}
      </span>
      {entry.git && (
        <span
          data-git
          title={branch ?? 'Git repository'}
          className="inline-flex h-5 min-w-0 max-w-[40%] shrink items-center gap-1 rounded-chip border border-line bg-bg-2 px-1.5 font-mono text-meta text-text-2"
        >
          <GitBranch aria-hidden className="size-3 shrink-0 text-text-3" strokeWidth={1.5} />
          <span className="truncate">{branch ?? 'git'}</span>
        </span>
      )}
      {entry.lastActiveAt !== null && (
        <time
          dateTime={new Date(entry.lastActiveAt).toISOString()}
          title={formatDateTime(entry.lastActiveAt)}
          className="w-16 shrink-0 text-right text-meta text-text-3 tabular max-sm:hidden"
        >
          {formatWhen(entry.lastActiveAt, now)}
        </time>
      )}
      {onBoard && entry.projectId !== null && (
        <ForgetButton projectId={entry.projectId} name={entry.name} />
      )}
    </Command.Item>
  );
}

/** Forget a recent project (12.6e) without picking its row: the confirm opens over the picker. */
function ForgetButton({ projectId, name }: { projectId: string; name: string }) {
  return (
    <Tooltip content={`Forget ${name}`}>
      <button
        type="button"
        aria-label={`Forget ${name}`}
        data-library-forget={name}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          requestClose(projectId, true);
        }}
        className="-mr-1 grid size-7 shrink-0 place-items-center rounded-control text-text-3 opacity-0 transition-[opacity,background-color,color] duration-fast hover:bg-bg-2 hover:text-text-1 focus-visible:opacity-100 group-data-[selected=true]/item:opacity-100 touch:size-11 touch:opacity-100"
      >
        <X aria-hidden className="size-3.5" strokeWidth={1.75} />
      </button>
    </Tooltip>
  );
}

function ListSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-1">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex h-10 items-center gap-3 px-3">
          <Skeleton className="size-5 rounded-full" />
          <Skeleton className={cx('h-3', i % 2 ? 'w-24' : 'w-36')} />
        </div>
      ))}
    </div>
  );
}

function LaunchSheet({
  entry,
  onBack,
  keepFocus,
}: {
  entry: LibraryEntry;
  onBack: () => void;
  keepFocus: () => void;
}) {
  const client = useBoardClient();
  const store = useBoardStore();
  const [, navigate] = useLocation();
  const projectId = entryProjectId(entry);
  const editor = useBoard((s) => editorName(s.board, projectId));
  const editorOpen = useBoard((s) =>
    Object.values(s.board.windows).some((w) => w.projectIds.includes(projectId)),
  );
  const [choice, setChoice] = useState<LaunchChoice>(() => launchMemory.get(entry.path));
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  // Read once: the chips shouldn't reshuffle while someone aims at one.
  const [chips] = useState(() => {
    const recent = recentCommands(store.getState().board, projectId);
    const remembered = launchMemory.get(entry.path).command.trim();
    return remembered && !recent.includes(remembered) ? [remembered, ...recent] : recent;
  });
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);
  const update = (patch: Partial<LaunchChoice>) => setChoice((c) => ({ ...c, ...patch }));
  const status = useServerStatus(null, !editorOpen);
  const host = terminalHost(editorOpen, status);
  const blocker = launchBlocker(choice, prompt, host === 'none');
  const avatar = { name: entry.name, accent: accentIndexForProject(projectId) };

  const launch = async () => {
    if (busy || blocker) return;
    setBusy(true);
    const outcome = await runLaunch({
      client,
      board: {
        has: (id) => store.getState().board.projects[id] !== undefined,
        subscribe: (listener) => store.subscribe(listener),
      },
      entry,
      choice,
      prompt,
    });
    setBusy(false);
    if (!outcome.ok) {
      toast.error(actionErrorText(outcome.error, `Could not open ${entry.name}`));
      return;
    }
    launchMemory.set(entry.path, choice);
    for (const failure of outcome.failed) {
      toast.error(STEP_NAME[failure.kind], {
        description: actionErrorText(failure.error, 'The server refused it'),
      });
    }
    keepFocus();
    close();
    navigate(
      outcome.sessionId
        ? sessionHref(outcome.projectId, outcome.sessionId)
        : projectHref(outcome.projectId),
    );
  };

  return (
    <form
      data-launch-sheet={entry.name}
      onSubmit={(e) => {
        e.preventDefault();
        void launch();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-center gap-3 border-line border-b px-4 py-3">
        <button
          type="button"
          aria-label="Back to the folders"
          onClick={onBack}
          className="-ml-1 grid size-8 shrink-0 touch:size-11 place-items-center rounded-control text-text-3 transition-[background-color,color,scale] duration-fast ease-out hover:bg-bg-2 hover:text-text-1 moving:active:scale-[0.97] max-md:size-11"
        >
          <ArrowLeft className="size-4" strokeWidth={1.5} />
        </button>
        <ProjectAvatar project={avatar} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-body text-text-1" title={entry.name}>
            {entry.name}
          </p>
          <p className="truncate font-mono text-meta text-text-3" title={entry.path}>
            {entry.path}
          </p>
        </div>
      </header>
      <div className="palette-list flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-3">
        <LaunchOption
          kind="editor"
          icon={<ExternalLink />}
          title={`Open in ${editor}`}
          description={
            editorOpen ? `Already open: brings its window forward` : 'Opens a new editor window'
          }
          checked={choice.editor}
          onChange={(editor) => update({ editor })}
        />
        <LaunchOption
          kind="claude"
          icon={<MessageSquarePlus />}
          title="New Claude session"
          description="Runs on the board, with your Claude Code login"
          checked={choice.claude}
          onChange={(claude) => {
            update({ claude });
            if (claude) requestAnimationFrame(() => promptRef.current?.focus());
          }}
        >
          <div className="flex flex-col gap-2 rounded-control border border-line bg-bg-0 px-3 pt-2.5 pb-2 transition-[border-color] duration-fast focus-within:border-line-strong">
            <textarea
              ref={promptRef}
              aria-label="What should Claude do?"
              placeholder={`What should Claude do in ${entry.name}?`}
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void launch();
                }
              }}
              className="field-sizing-content max-h-40 min-h-12 w-full resize-none bg-transparent text-body text-text-1 leading-6 outline-none placeholder:text-text-3 focus-visible:shadow-none"
            />
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Pill
                name="Model"
                icon={<Cpu />}
                label={modelLabel(choice.model || null)}
                value={choice.model}
                options={MODEL_OPTIONS}
                disabled={false}
                onChange={(model) => update({ model })}
              />
              <Pill
                name="Permission mode"
                icon={<ShieldCheck />}
                label={permissionLabel(choice.permissionMode)}
                value={choice.permissionMode}
                options={PERMISSION_OPTIONS}
                disabled={false}
                onChange={(value) => update({ permissionMode: value as PermissionMode })}
              />
            </div>
          </div>
        </LaunchOption>
        <LaunchOption
          kind="terminal"
          icon={<SquareTerminal />}
          title="New terminal"
          description={
            host === 'editor'
              ? 'Opens in the editor window'
              : host === 'board'
                ? 'Runs on the board, in the project folder'
                : BOARD_TERMINALS_OFF
          }
          checked={choice.terminal}
          onChange={(terminal) => {
            update({ terminal });
            if (terminal) requestAnimationFrame(() => commandRef.current?.focus());
          }}
        >
          <label className="flex min-w-0 items-center gap-2 rounded-control border border-line bg-bg-0 pr-1.5 pl-3 transition-colors duration-fast focus-within:border-line-strong focus-within:shadow-[var(--focus-ring)]">
            <span aria-hidden className="font-mono text-label text-text-3">
              $
            </span>
            <input
              ref={commandRef}
              aria-label="Command to run (optional)"
              placeholder="Command to run (optional)"
              value={choice.command}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              onChange={(e) => update({ command: e.target.value })}
              className="h-9 min-w-0 flex-1 bg-transparent font-mono text-label text-text-1 outline-none placeholder:font-sans placeholder:text-text-3 focus-visible:shadow-none touch:h-11"
            />
          </label>
          {chips.length > 0 && (
            <fieldset className="flex min-w-0 flex-wrap gap-1.5" aria-label="Recent commands">
              {chips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  data-command-chip={chip}
                  title={chip}
                  aria-pressed={choice.command.trim() === chip}
                  onClick={() => update({ command: choice.command.trim() === chip ? '' : chip })}
                  className={cx(
                    'inline-flex h-7 min-w-0 max-w-full items-center rounded-chip border px-2.5 font-mono text-label touch:h-11',
                    'transition-[border-color,background-color,color,scale] duration-fast ease-out moving:active:scale-[0.97]',
                    choice.command.trim() === chip
                      ? 'border-line-strong bg-bg-2 text-text-1'
                      : 'border-line bg-bg-1 text-text-2 hover:border-line-strong hover:text-text-1',
                  )}
                >
                  <span className="truncate">{chip}</span>
                </button>
              ))}
            </fieldset>
          )}
        </LaunchOption>
      </div>
      <footer className="flex shrink-0 items-center gap-3 border-line border-t px-4 py-3">
        <p
          data-launch-summary
          aria-live="polite"
          className={cx(
            'min-w-0 flex-1 truncate text-label',
            blocker ? 'text-text-3' : 'text-text-2',
          )}
          title={blocker ?? launchSummary(choice, editor)}
        >
          {blocker ?? launchSummary(choice, editor)}
        </p>
        <button
          type="submit"
          disabled={busy || blocker !== null}
          aria-busy={busy}
          className={cx(buttonClass('primary', 'md'), 'touch:h-11 touch:px-4')}
        >
          {busy && <LoaderCircle aria-hidden className="hud-spin size-4" strokeWidth={1.5} />}
          Open project
        </button>
      </footer>
    </form>
  );
}

function LaunchOption({
  kind,
  icon,
  title,
  description,
  checked,
  onChange,
  children,
}: {
  kind: LaunchStep['kind'];
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  const level = useMotionLevel();
  return (
    <div
      data-launch-option={kind}
      data-checked={checked || undefined}
      className={cx(
        'rounded-panel border transition-[border-color,background-color] duration-fast',
        checked
          ? 'border-line-strong bg-bg-2/60'
          : 'border-line bg-transparent hover:border-line-strong',
      )}
    >
      <label className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className={cx(
            'grid size-4 shrink-0 place-items-center rounded-[5px] border transition-[background-color,border-color] duration-fast peer-focus-visible:shadow-[var(--focus-ring)]',
            checked ? 'border-text-1 bg-text-1 text-bg-0' : 'border-line-strong bg-bg-0',
          )}
        >
          <Check
            className={cx(
              'size-3 transition-[opacity,scale] duration-fast ease-out',
              checked ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
            )}
            strokeWidth={2.5}
          />
        </span>
        <span className="flex shrink-0 text-text-2 [&_svg]:size-4 [&_svg]:stroke-[1.5]">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-body-sm text-text-1">{title}</span>
          <span className="block truncate text-meta text-text-3">{description}</span>
        </span>
      </label>
      {checked && children && (
        <motion.div
          initial={level === 'off' ? false : { opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: dur.base, ease: ease.out } }}
          className="flex flex-col gap-2 px-3 pb-3"
        >
          {children}
        </motion.div>
      )}
    </div>
  );
}
