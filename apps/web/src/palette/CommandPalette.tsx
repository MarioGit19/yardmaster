import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import {
  Activity,
  ArrowLeft,
  BellDot,
  CheckCheck,
  CircleStop,
  CornerDownLeft,
  ExternalLink,
  FolderOpen,
  FolderX,
  LayoutDashboard,
  LayoutGrid,
  type LucideIcon,
  MessageSquarePlus,
  PanelLeft,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  SquareTerminal,
  SunMoon,
  Trash2,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { attentionOpen } from '../attention/attention.js';
import { useBoard, useBoardClient } from '../data/index.js';
import { useFocusRoute } from '../focus/FocusStage.js';
import { layoutPreference } from '../layouts/registry.js';
import { requestClose } from '../library/closing.js';
import { pickerOpen } from '../library/OpenProject.js';
import { dur, ease, motionPreference, nextMotion } from '../motion.js';
import { useMediaQuery, usePreference } from '../prefs.js';
import { togglePulse } from '../pulse/prefs.js';
import { inProject, projectHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { NARROW_QUERY, railPreference } from '../shell/prefs.js';
import { newTerminalRequest } from '../terminal/newTerminal.js';
import { actionErrorText } from '../terminal/stack.js';
import { terminalTarget } from '../terminal/target.js';
import { NEXT_THEME, themePreference } from '../theme/theme.js';
import { SheetPanel } from '../ui/BottomSheet.js';
import { cx } from '../ui/cx.js';
import { Kbd } from '../ui/Kbd.js';
import { StatusDot } from '../ui/StatusDot.js';
import {
  buildCommands,
  type PaletteCommand,
  type PaletteIcon,
  type PaletteResult,
  type PaletteRun,
  searchCommands,
} from './commands.js';
import { highlightRuns } from './fuzzy.js';
import { isPaletteShortcut, paletteOpen } from './palette.js';

const ICONS: Record<Exclude<PaletteIcon, 'project' | 'session'>, LucideIcon> = {
  terminal: SquareTerminal,
  new: MessageSquarePlus,
  interrupt: CircleStop,
  approve: CheckCheck,
  rerun: RotateCcw,
  editor: ExternalLink,
  motion: Sparkles,
  theme: SunMoon,
  layout: LayoutDashboard,
  settings: Settings,
  attention: BellDot,
  rail: PanelLeft,
  pulse: Activity,
  overview: LayoutGrid,
  open: FolderOpen,
  close: FolderX,
  forget: Trash2,
};

type Page = { kind: 'root' } | { kind: 'prompt'; projectId: string; projectName: string };

const close = () => paletteOpen.set('closed');

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * ⌘K, DESIGN.md §4.8: a glass modal over cmdk with Projects, Sessions, Terminals and Actions.
 * Destinations navigate as a click would, so the focus view still morphs out of its pod.
 */
export function CommandPalette() {
  const open = usePreference(paletteOpen) === 'open';
  // A bottom sheet on phones (DESIGN.md §11).
  const narrow = useMediaQuery(NARROW_QUERY);
  // Set when a command moves focus on its own (a new view, the Attention Center).
  const keepFocus = useRef(false);
  // A sub-page handles Esc itself (back to all commands) instead of closing.
  const onEscape = useRef<(() => boolean) | null>(null);

  useEffect(() => {
    // Capture: the shortcut works even from inside a terminal.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      paletteOpen.set(paletteOpen.get() === 'open' ? 'closed' : 'open');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => paletteOpen.set(next ? 'open' : 'closed')}>
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
                  data-palette
                  onDismiss={() => paletteOpen.set('closed')}
                  className="overflow-hidden"
                >
                  <Dialog.Title className="sr-only">Command palette</Dialog.Title>
                  <PaletteBody
                    keepFocus={() => {
                      keepFocus.current = true;
                    }}
                    onEscape={onEscape}
                  />
                </SheetPanel>
              ) : (
                <motion.div
                  data-palette
                  className="palette fixed top-[12vh] left-1/2 z-50 flex max-h-[min(560px,76vh)] w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden rounded-modal border border-line-strong shadow-raised outline-none"
                  style={{ x: '-50%' }}
                  // Opened from the keyboard many times a day: quick, so it never holds up typing.
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
                  <Dialog.Title className="sr-only">Command palette</Dialog.Title>
                  <PaletteBody
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

function PaletteBody({
  keepFocus,
  onEscape,
}: {
  keepFocus: () => void;
  onEscape: RefObject<(() => boolean) | null>;
}) {
  const board = useBoard((s) => s.board);
  const client = useBoardClient();
  const [location, navigate] = useLocation();
  const focus = useFocusRoute();
  const motion = usePreference(motionPreference);
  const theme = usePreference(themePreference);
  const layout = usePreference(layoutPreference);
  const narrow = useMediaQuery(NARROW_QUERY);
  const [page, setPage] = useState<Page>({ kind: 'root' });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const commands = useMemo(
    () =>
      buildCommands(board, {
        projectId: focus?.projectId ?? null,
        motion,
        nextMotion: nextMotion(motion),
        theme,
        nextTheme: NEXT_THEME[theme],
        layout,
        railToggle: !narrow,
        mac: IS_MAC,
      }),
    [board, focus?.projectId, motion, theme, layout, narrow],
  );
  const sections = useMemo(
    () => (page.kind === 'root' ? searchCommands(commands, query) : []),
    [commands, query, page.kind],
  );
  const ids = sections.flatMap((s) => s.results.map((r) => r.command.id));
  // The first result stays selected while typing, and when live data removes the selection.
  const value = ids.includes(selected) ? selected : (ids[0] ?? '');

  const toPage = (next: Page) => {
    setPage(next);
    setQuery('');
    setSelected('');
    input.current?.focus();
  };

  const run = (command: PaletteCommand) => execute(command.run);

  const execute = async (action: PaletteRun) => {
    switch (action.kind) {
      case 'navigate':
        keepFocus();
        close();
        if (action.terminal) {
          terminalTarget.set(action.terminal);
          // Already in its focus view: only the stack changes, the Claude column keeps its session.
          if (inProject(location, action.terminal.projectId)) return;
        }
        navigate(action.href);
        return;
      case 'action': {
        close();
        const result = await client.action(action.action);
        if (result.ok) toast.success(action.done);
        else toast.error(actionErrorText(result.error, 'That action failed'));
        return;
      }
      case 'approveAll':
        close();
        await approveAll(action.approvalIds);
        return;
      case 'newSession':
        toPage({ kind: 'prompt', projectId: action.projectId, projectName: action.projectName });
        return;
      case 'newTerminal':
        // The project's focus view opens the popover by its "New terminal" button.
        keepFocus();
        close();
        newTerminalRequest.set(action.projectId);
        if (!inProject(location, action.projectId)) navigate(projectHref(action.projectId));
        return;
      case 'motion':
        motionPreference.set(action.next);
        close();
        return;
      case 'theme':
        themePreference.set(action.next);
        close();
        return;
      case 'layout':
        layoutPreference.set(action.next);
        close();
        return;
      case 'openProject':
        keepFocus();
        close();
        pickerOpen.set('open');
        return;
      case 'closeProject':
        keepFocus();
        close();
        requestClose(action.projectId, action.forget);
        return;
      case 'attention':
        keepFocus();
        close();
        attentionOpen.set('open');
        return;
      case 'pulse':
        togglePulse();
        close();
        return;
      case 'rail':
        railPreference.set(railPreference.get() === 'collapsed' ? 'expanded' : 'collapsed');
        close();
        return;
    }
  };

  const approveAll = async (approvalIds: readonly string[]) => {
    const results = await Promise.all(
      approvalIds.map((approvalId) =>
        client.request('approval.decide', { approvalId, decision: 'allow' }),
      ),
    );
    const approved = results.filter((r) => r.ok).length;
    const failed = results.find((r) => !r.ok);
    if (approved > 0)
      toast.success(approved === 1 ? 'Approved 1 request' : `Approved ${approved} requests`);
    if (failed && !failed.ok)
      toast.error(actionErrorText(failed.error, 'Some requests were not approved'));
  };

  const startSession = async (projectId: string) => {
    const prompt = query.trim();
    if (!prompt) return;
    close();
    const result = await client.action({ kind: 'session.create', projectId, prompt });
    if (result.ok) toast.success('Session started');
    else toast.error(actionErrorText(result.error, 'The session did not start'));
  };

  onEscape.current = () => {
    if (page.kind === 'root') return false;
    toPage({ kind: 'root' });
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Backspace on an empty prompt backs out, like Esc.
    if (page.kind !== 'root' && event.key === 'Backspace' && query === '') {
      event.preventDefault();
      toPage({ kind: 'root' });
    }
  };

  return (
    <Command
      label="Command palette"
      shouldFilter={false}
      loop
      value={value}
      onValueChange={setSelected}
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-line border-b px-4">
        {page.kind === 'prompt' && (
          <button
            type="button"
            aria-label="Back to all commands"
            onClick={() => toPage({ kind: 'root' })}
            className="-ml-1 grid size-7 shrink-0 place-items-center rounded-control text-text-3 transition-[background-color,color,scale] duration-fast ease-out hover:bg-bg-2 hover:text-text-1 moving:active:scale-[0.97]"
          >
            <ArrowLeft className="size-4" strokeWidth={1.5} />
          </button>
        )}
        {page.kind === 'root' && (
          <Search aria-hidden className="size-4 shrink-0 text-text-3" strokeWidth={1.5} />
        )}
        <Command.Input
          ref={input}
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={
            page.kind === 'prompt'
              ? `What should Claude do in ${page.projectName}?`
              : 'Search or run a command'
          }
          className="h-14 min-w-0 flex-1 bg-transparent text-body text-text-1 outline-none placeholder:text-text-3 focus-visible:shadow-none"
        />
        <Kbd className="shrink-0 max-sm:hidden">Esc</Kbd>
      </div>
      <Command.List className="palette-list min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {page.kind === 'prompt' ? (
          <Command.Item
            value="start-session"
            disabled={query.trim() === ''}
            onSelect={() => startSession(page.projectId)}
            className="palette-item"
          >
            <ItemIcon icon="new" />
            <span className="min-w-0 flex-1 truncate">
              {query.trim() ? `Start a session in ${page.projectName}` : 'Type a prompt to start'}
            </span>
            <Kbd className="palette-enter">
              <CornerDownLeft aria-label="Enter" className="size-3" strokeWidth={1.5} />
            </Kbd>
          </Command.Item>
        ) : (
          <>
            <Command.Empty className="px-3 py-8 text-center text-body-sm text-text-2">
              Nothing matches “{query.trim()}”
            </Command.Empty>
            {sections.map((section) => (
              <Command.Group
                key={section.group}
                heading={section.group}
                value={section.group}
                className="palette-group"
              >
                {section.results.map((result) => (
                  <PaletteItem key={result.command.id} result={result} onRun={run} />
                ))}
              </Command.Group>
            ))}
          </>
        )}
      </Command.List>
      <footer className="flex shrink-0 items-center gap-4 border-line border-t px-4 py-2 text-meta text-text-3 max-sm:hidden">
        {page.kind === 'root' && (
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            to move
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <Kbd>
            <CornerDownLeft aria-label="Enter" className="size-3" strokeWidth={1.5} />
          </Kbd>
          {page.kind === 'prompt' ? 'to start' : 'to open'}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>Esc</Kbd>
          {page.kind === 'prompt' ? 'to go back' : 'to close'}
        </span>
      </footer>
    </Command>
  );
}

function PaletteItem({
  result,
  onRun,
}: {
  result: PaletteResult;
  onRun: (command: PaletteCommand) => void;
}) {
  const { command, indices } = result;
  return (
    <Command.Item
      value={command.id}
      onSelect={() => onRun(command)}
      data-command={command.id}
      className="palette-item"
    >
      {command.icon === 'project' ? (
        <span className="grid size-5 shrink-0 place-items-center">
          {command.project && <ProjectAvatar project={command.project} size="sm" />}
        </span>
      ) : command.icon === 'session' ? (
        <span className="grid size-5 shrink-0 place-items-center">
          <StatusDot tone={command.tone ?? 'idle'} label={command.hint ?? ''} />
        </span>
      ) : (
        <ItemIcon icon={command.icon} />
      )}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="palette-label min-w-0 shrink truncate" title={command.label}>
          {highlightRuns(command.label, indices).map((run, i) =>
            run.hit ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
              <mark key={i}>{run.text}</mark>
            ) : (
              run.text
            ),
          )}
        </span>
        {command.hint && (
          <span
            className={cx(
              'min-w-0 flex-1 truncate text-meta text-text-3',
              command.hintMono && 'font-mono',
            )}
            title={command.hint}
          >
            {command.hint}
          </span>
        )}
      </span>
      {command.shortcut && (
        <span className="flex shrink-0 items-center gap-0.5">
          {command.shortcut.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </span>
      )}
    </Command.Item>
  );
}

function ItemIcon({ icon }: { icon: Exclude<PaletteIcon, 'project' | 'session'> }) {
  const Icon = ICONS[icon];
  return <Icon aria-hidden className="palette-icon size-4 shrink-0" strokeWidth={1.5} />;
}
