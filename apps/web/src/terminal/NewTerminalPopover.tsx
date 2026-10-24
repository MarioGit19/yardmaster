import { LoaderCircle, Sparkle, SquareTerminal } from 'lucide-react';
import { type ReactElement, type Ref, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useBoard, useBoardClient, useBoardStore } from '../data/index.js';
import { draftKey, drafts } from '../drafts/drafts.js';
import { useServerStatus } from '../settings/useServerStatus.js';
import { buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { Popover } from '../ui/Popover.js';
import {
  BOARD_TERMINALS_OFF,
  CLAUDE_COMMAND,
  recentCommands,
  terminalHost,
} from './newTerminal.js';
import { actionErrorText } from './stack.js';

/** Errors that mean no editor window can open a terminal for the project. */
const NO_EDITOR = new Set(['no_editor', 'editor_offline', 'editor_disconnected']);

export interface NewTerminalPopoverProps {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Must forward its ref. */
  trigger: ReactElement;
  /** The editor accepted `terminal.create`; the terminal itself shows up a moment later. */
  onCreated: (command: string | null) => void;
}

const HOST_NOTE = {
  editor: 'Opens in the editor window.',
  board: 'Runs on the board, in the project folder.',
  none: BOARD_TERMINALS_OFF,
} as const;

/**
 * Opens a terminal (`terminal.create`) in the project's editor window, or as a board terminal
 * (F19) when no window has the project, optionally running a command: typed, or one tap on a
 * recent command or on `claude`.
 */
export function NewTerminalPopover({
  projectId,
  projectName,
  open,
  onOpenChange,
  trigger,
  onCreated,
}: NewTerminalPopoverProps) {
  const input = useRef<HTMLInputElement>(null);
  // Closed by a successful create: focus goes to the new tab once it shows up, not the trigger.
  const created = useRef(false);
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={`New terminal in ${projectName}`}
      align="end"
      className="flex w-80 max-w-[calc(100vw-32px)] flex-col gap-3"
      data-new-terminal-popover
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        const el = input.current;
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
      }}
      onCloseAutoFocus={(e) => {
        if (!created.current) return;
        created.current = false;
        e.preventDefault();
      }}
      trigger={trigger}
    >
      <p className="min-w-0 truncate font-medium text-body-sm text-text-1" title={projectName}>
        New terminal in {projectName}
      </p>
      <NewTerminalForm
        projectId={projectId}
        projectName={projectName}
        inputRef={input}
        onCreated={(command) => {
          created.current = true;
          onOpenChange(false);
          onCreated(command);
        }}
      />
    </Popover>
  );
}

export interface NewTerminalFormProps {
  projectId: string;
  projectName: string;
  inputRef?: Ref<HTMLInputElement>;
  /** The editor accepted `terminal.create`; the terminal itself shows up a moment later. */
  onCreated: (command: string | null) => void;
}

/**
 * The new-terminal form: a command line, chips for `claude` and the project's recent commands,
 * and where it will open. In the popover, and in the phone workspace's + New sheet.
 */
export function NewTerminalForm({
  projectId,
  projectName,
  inputRef,
  onCreated,
}: NewTerminalFormProps) {
  const client = useBoardClient();
  const store = useBoardStore();
  const draft = draftKey.newTerminal(projectId);
  // Kept when the form closes unsent; cleared once a terminal opens.
  const [command, setCommand] = useState(() => drafts.get(draft));
  const [busy, setBusy] = useState<string | null>(null);
  // Read once per opening: the chips shouldn't reshuffle while someone aims at one.
  const [recent] = useState(() => recentCommands(store.getState().board, projectId));
  const editorOpen = useBoard((s) =>
    Object.values(s.board.windows).some((w) => w.projectIds.includes(projectId)),
  );
  const status = useServerStatus(null, !editorOpen);
  const host = terminalHost(editorOpen, status);
  const off = host === 'none';

  const create = async (line: string) => {
    if (busy !== null || off) return;
    const trimmed = line.trim();
    setBusy(trimmed);
    const result = await client.action({
      kind: 'terminal.create',
      projectId,
      ...(trimmed !== '' ? { command: trimmed } : {}),
    });
    setBusy(null);
    if (!result.ok) {
      if (NO_EDITOR.has(result.error)) {
        toast.error(`Open ${projectName} in a Cursor window first`, {
          description: 'New terminals open in the editor window that has this project.',
        });
      } else toast.error(actionErrorText(result.error, 'Could not open a terminal'));
      return;
    }
    setCommand('');
    drafts.clear(draft);
    onCreated(trimmed === '' ? null : trimmed);
  };

  const chips = [CLAUDE_COMMAND, ...recent];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void create(command);
      }}
      className="flex flex-col gap-3"
    >
      <label className="flex min-w-0 items-center gap-2 rounded-control border border-line bg-bg-0 pr-1.5 pl-3 transition-colors duration-fast focus-within:border-line-strong focus-within:shadow-[var(--focus-ring)]">
        <span aria-hidden className="font-mono text-label text-text-3">
          $
        </span>
        <input
          ref={inputRef}
          aria-label="Command to run (optional)"
          placeholder="Command to run (optional)"
          value={command}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          onChange={(e) => {
            setCommand(e.target.value);
            drafts.set(draft, e.target.value);
          }}
          className="h-9 min-w-0 flex-1 bg-transparent font-mono text-label text-text-1 outline-none placeholder:font-sans placeholder:text-text-3 focus-visible:shadow-none touch:h-11"
        />
      </label>
      <fieldset className="flex min-w-0 flex-col gap-1.5">
        <legend className="mb-1.5 text-meta text-text-2">Start with</legend>
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              data-command-chip={chip}
              title={chip}
              disabled={busy !== null || off}
              onClick={() => void create(chip)}
              className={cx(
                'inline-flex h-7 min-w-0 max-w-full items-center touch:h-11 touch:px-3.5 gap-1.5 rounded-chip border border-line bg-bg-2 px-2.5 font-mono text-label text-text-1',
                'transition-[border-color,background-color,scale] duration-fast ease-out hover:border-line-strong moving:active:scale-[0.97] disabled:opacity-50',
              )}
            >
              {busy === chip ? (
                <LoaderCircle
                  aria-hidden
                  className="hud-spin size-3.5 shrink-0"
                  strokeWidth={1.5}
                />
              ) : chip === CLAUDE_COMMAND ? (
                <Sparkle aria-hidden className="size-3.5 shrink-0 text-text-2" strokeWidth={1.5} />
              ) : null}
              <span className="truncate">{chip}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center justify-between gap-3">
        <p
          data-terminal-host={host}
          className={cx('min-w-0 text-meta', off ? 'text-text-2' : 'text-text-3')}
        >
          {HOST_NOTE[host]}
          {off && ` Open ${projectName} in Cursor first.`}
        </p>
        <button
          type="submit"
          disabled={busy !== null || off}
          aria-busy={busy === command.trim()}
          className={buttonClass('primary', 'sm')}
        >
          {busy !== null && busy === command.trim() ? (
            <LoaderCircle aria-hidden className="hud-spin size-3.5" strokeWidth={1.5} />
          ) : (
            <SquareTerminal aria-hidden className="size-3.5" strokeWidth={1.5} />
          )}
          Open terminal
        </button>
      </div>
    </form>
  );
}
