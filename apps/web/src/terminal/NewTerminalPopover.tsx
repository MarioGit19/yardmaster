import { LoaderCircle, Sparkle, SquareTerminal } from 'lucide-react';
import { type ReactElement, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useBoardClient, useBoardStore } from '../data/index.js';
import { buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { Popover } from '../ui/Popover.js';
import { CLAUDE_COMMAND, recentCommands } from './newTerminal.js';
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

/**
 * Opens a terminal in the project's editor window (`terminal.create`), optionally running a
 * command: typed, or one tap on a recent command or on `claude`. The launch sheet (12.2) reuses it.
 */
export function NewTerminalPopover({
  projectId,
  projectName,
  open,
  onOpenChange,
  trigger,
  onCreated,
}: NewTerminalPopoverProps) {
  const client = useBoardClient();
  const store = useBoardStore();
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Closed by a successful create: focus goes to the new tab once it shows up, not the trigger.
  const created = useRef(false);
  // Read once per opening: the chips shouldn't reshuffle while someone aims at one.
  const [recent, setRecent] = useState<string[]>([]);

  const change = (next: boolean) => {
    if (next) setRecent(recentCommands(store.getState().board, projectId));
    else setCommand('');
    onOpenChange(next);
  };

  const create = async (line: string) => {
    if (busy !== null) return;
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
    created.current = true;
    change(false);
    onCreated(trimmed === '' ? null : trimmed);
  };

  const chips = [CLAUDE_COMMAND, ...recent];
  return (
    <Popover
      open={open}
      onOpenChange={change}
      label={`New terminal in ${projectName}`}
      align="end"
      className="flex w-80 max-w-[calc(100vw-32px)] flex-col gap-3"
      data-new-terminal-popover
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        input.current?.focus();
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
            ref={input}
            aria-label="Command to run (optional)"
            placeholder="Command to run (optional)"
            value={command}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            onChange={(e) => setCommand(e.target.value)}
            className="h-9 min-w-0 flex-1 bg-transparent font-mono text-label text-text-1 outline-none placeholder:font-sans placeholder:text-text-3 focus-visible:shadow-none"
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
                disabled={busy !== null}
                onClick={() => void create(chip)}
                className={cx(
                  'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-chip border border-line bg-bg-2 px-2.5 font-mono text-label text-text-1',
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
                  <Sparkle
                    aria-hidden
                    className="size-3.5 shrink-0 text-text-2"
                    strokeWidth={1.5}
                  />
                ) : null}
                <span className="truncate">{chip}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-meta text-text-3">Opens in the editor window.</p>
          <button
            type="submit"
            disabled={busy !== null}
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
    </Popover>
  );
}
