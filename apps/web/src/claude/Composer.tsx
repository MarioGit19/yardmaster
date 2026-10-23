import {
  type Approval,
  type ClaudeSession,
  type PermissionMode,
  terminalReplyBlock,
} from '@c-board/protocol';
import {
  ArrowUp,
  ChevronDown,
  Cpu,
  Ellipsis,
  ExternalLink,
  GitFork,
  LoaderCircle,
  ShieldCheck,
  Square,
  TriangleAlert,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { ApprovalCard } from '../attention/ApprovalCard.js';
import { type AttentionDecision, canAlwaysAllow } from '../attention/attention.js';
import { selectApproval, useBoard, useBoardClient } from '../data/index.js';
import { dur, ease, move, spring, useMotionLevel } from '../motion.js';
import { sessionHref } from '../routes.js';
import { useBoardSettings } from '../settings/boardSettings.js';
import { ESC } from '../terminal/claudeTerminal.js';
import { actionErrorText } from '../terminal/stack.js';
import { buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { IconButton } from '../ui/IconButton.js';
import { Popover } from '../ui/Popover.js';
import { Tooltip } from '../ui/Tooltip.js';
import {
  composerKey,
  isSessionLive,
  isTurnRunning,
  MODEL_OPTIONS,
  modelLabel,
  modelValue,
  PERMISSION_OPTIONS,
  permissionLabel,
  type SendButtonMode,
  sendButtonMode,
} from './composerModel.js';
import { chatColumn, useCompactChat } from './density.js';

const ERRORS: Record<string, string> = {
  session_not_running: 'The session is not running',
  session_live: 'The session is still running in its terminal',
  unknown_session: 'The session is gone',
  unknown_project: 'The project is gone',
  terminal_reply_disabled: 'Reply in terminal is turned off in Settings',
  session_busy: 'Claude is busy. Reply when it is idle or waiting for you',
  no_linked_terminal: 'The session has no linked terminal',
  empty_reply: 'Nothing to send',
};
const errorText = (code: string, fallback: string) =>
  ERRORS[code] ?? actionErrorText(code, fallback);

/**
 * The Claude panel's input for a session: a board session's composer, or for a terminal session
 * the same composer typing into its terminal (F14), or the fork bar where it can't.
 */
export function SessionComposer({ session }: { session: ClaudeSession }) {
  if (session.origin === 'terminal') return <TerminalSessionComposer session={session} />;
  return <BoardComposer session={session} />;
}

function BoardComposer({ session }: { session: ClaudeSession }) {
  const client = useBoardClient();
  const running = isTurnRunning(session.status);
  // Model and mode switch on the live query; a stopped session picks them up on resume.
  const live = session.status.kind !== 'ended' && session.status.kind !== 'error';

  const control = async (
    action:
      | { kind: 'session.setModel'; sessionId: string; model: string }
      | { kind: 'session.setPermissionMode'; sessionId: string; permissionMode: PermissionMode },
  ) => {
    const result = await client.action(action);
    if (!result.ok) toast.error(errorText(result.error, 'Could not change the session'));
  };

  return (
    <Composer
      key={session.id}
      label={`Message ${session.title ?? 'Claude'}`}
      placeholder={running ? 'Queue a follow-up…' : 'Reply to Claude…'}
      running={running}
      model={session.model}
      permissionMode={session.permissionMode}
      controlsDisabled={!live}
      onModel={(model) =>
        model && control({ kind: 'session.setModel', sessionId: session.id, model })
      }
      onPermissionMode={(permissionMode) =>
        control({ kind: 'session.setPermissionMode', sessionId: session.id, permissionMode })
      }
      onSend={async (text) => {
        const result = await client.request('session.send', { sessionId: session.id, text });
        if (!result.ok) toast.error(errorText(result.error, 'Could not send the message'));
        return result.ok;
      }}
      onInterrupt={async () => {
        const result = await client.action({ kind: 'session.interrupt', sessionId: session.id });
        if (!result.ok) toast.error(errorText(result.error, 'Could not interrupt Claude'));
      }}
    />
  );
}

/** Starts a board session in a project; the route moves to it once the server has it. */
export function NewSessionComposer({ projectId }: { projectId: string }) {
  const client = useBoardClient();
  const [, navigate] = useLocation();
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  return (
    <Composer
      label="First message for a new session"
      placeholder="Ask Claude to…"
      autoFocus
      running={false}
      model={model || null}
      permissionMode={permissionMode}
      onModel={setModel}
      onPermissionMode={setPermissionMode}
      onSend={async (prompt) => {
        const result = await client.action({
          kind: 'session.create',
          projectId,
          prompt,
          ...(model ? { model } : {}),
          ...(permissionMode !== 'default' ? { permissionMode } : {}),
        });
        if (!result.ok) {
          toast.error(errorText(result.error, 'Could not start the session'));
          return false;
        }
        if (result.sessionId) navigate(sessionHref(projectId, result.sessionId));
        return true;
      }}
      onInterrupt={() => {}}
    />
  );
}

interface ComposerProps {
  label: string;
  placeholder: string;
  autoFocus?: boolean;
  running: boolean;
  model: string | null;
  permissionMode: PermissionMode | null;
  controlsDisabled?: boolean;
  onModel: (model: string) => void;
  onPermissionMode: (mode: PermissionMode) => void;
  /** Resolves with whether the message went out; the text is kept when it didn't. */
  onSend: (text: string) => Promise<boolean>;
  onInterrupt: () => void;
  /** Terminal sessions: the TUI owns model and mode, so the pills give way to this menu. */
  menu?: ReactNode;
  /** Send is off (the text stays editable): a busy TUI takes no queued input. */
  sendBlocked?: boolean;
  /** Replaces the keyboard hint beside the send button. */
  hint?: string;
}

function Composer({
  label,
  placeholder,
  autoFocus = false,
  running,
  model,
  permissionMode,
  controlsDisabled = false,
  onModel,
  onPermissionMode,
  onSend,
  onInterrupt,
  menu,
  sendBlocked = false,
  hint,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mode = sendButtonMode({ sending, running, text });
  const column = chatColumn(useCompactChat());

  const send = async () => {
    const prompt = text.trim();
    if (!prompt || sending || sendBlocked) return;
    setSending(true);
    const ok = await onSend(prompt);
    setSending(false);
    if (ok) setText('');
    inputRef.current?.focus();
  };

  const modelOptions = MODEL_OPTIONS.some((o) => o.value === modelValue(model))
    ? MODEL_OPTIONS
    : [...MODEL_OPTIONS, { value: modelValue(model), label: modelLabel(model) }];

  return (
    <form
      data-composer
      onSubmit={(e) => {
        e.preventDefault();
        if (mode === 'stop') onInterrupt();
        else void send();
      }}
      className={column.dock}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-control border border-line bg-bg-2 px-3 pt-2.5 pb-2 shadow-raised transition-[border-color] duration-fast focus-within:border-line-strong">
        <textarea
          ref={inputRef}
          aria-label={label}
          aria-keyshortcuts="Enter Shift+Enter Escape"
          placeholder={placeholder}
          // biome-ignore lint/a11y/noAutofocus: the new-session composer exists to be typed into.
          autoFocus={autoFocus}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            const key = composerKey(
              { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing },
              running,
            );
            if (key === 'send') {
              e.preventDefault();
              void send();
            } else if (key === 'interrupt') {
              // Handled here, so the focus view doesn't close on the same Escape.
              e.preventDefault();
              onInterrupt();
            }
          }}
          className="field-sizing-content max-h-48 min-h-6 w-full resize-none bg-transparent text-body text-text-1 leading-6 outline-none placeholder:text-text-3 focus-visible:shadow-none"
        />
        <div className="flex min-w-0 items-center gap-1.5">
          {menu ?? (
            <>
              <Pill
                name="Model"
                icon={<Cpu />}
                label={modelLabel(model)}
                value={modelValue(model)}
                options={modelOptions}
                disabled={controlsDisabled}
                onChange={onModel}
              />
              <Pill
                name="Permission mode"
                icon={<ShieldCheck />}
                label={permissionLabel(permissionMode)}
                value={permissionMode ?? 'default'}
                options={PERMISSION_OPTIONS}
                disabled={controlsDisabled}
                onChange={(value) => onPermissionMode(value as PermissionMode)}
              />
            </>
          )}
          <span className="ml-auto hidden truncate text-meta text-text-3 xl:block">
            {hint ?? (running ? 'Esc to stop' : 'Shift+Enter for a new line')}
          </span>
          <SendButton
            mode={mode}
            disabled={mode === 'send' && (text.trim() === '' || sendBlocked)}
          />
        </div>
      </div>
    </form>
  );
}

function Pill<V extends string>({
  name,
  icon,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  name: string;
  icon: ReactNode;
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  disabled: boolean;
  onChange: (value: V) => void;
}) {
  return (
    <label
      title={disabled ? `${name}: the session isn't running` : name}
      className={cx(
        'relative inline-flex h-6 min-w-0 items-center gap-1.5 rounded-chip border border-line bg-bg-1 px-2 text-label text-text-2 transition-[border-color,color] duration-fast',
        'has-[select:focus-visible]:shadow-focus',
        disabled ? 'opacity-50' : 'hover:border-line-strong hover:text-text-1',
      )}
    >
      <span aria-hidden className="hidden shrink-0 text-text-3 sm:flex [&_svg]:size-3.5">
        {icon}
      </span>
      <span aria-hidden className="truncate">
        {label}
      </span>
      <ChevronDown aria-hidden className="size-3 shrink-0 text-text-3" strokeWidth={1.5} />
      {/* The native select keeps keyboard and screen-reader behaviour; the pill is its face. */}
      <select
        aria-label={name}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as V)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0 disabled:cursor-default"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const SEND_LABEL: Record<SendButtonMode, string> = {
  send: 'Send',
  sending: 'Sending…',
  stop: 'Stop Claude',
};

/** One button that morphs between send, sending and stop, so the target never moves. */
function SendButton({ mode, disabled }: { mode: SendButtonMode; disabled: boolean }) {
  const still = useMotionLevel() !== 'full';
  const icon =
    mode === 'stop' ? (
      <Square className="size-3 fill-current" strokeWidth={1.5} />
    ) : mode === 'sending' ? (
      <LoaderCircle className="hud-spin size-4" strokeWidth={1.5} />
    ) : (
      <ArrowUp className="size-4" strokeWidth={1.5} />
    );
  return (
    <Tooltip content={SEND_LABEL[mode]} shortcut={mode === 'stop' ? 'Esc' : 'Enter'} side="top">
      <button
        type="submit"
        aria-label={SEND_LABEL[mode]}
        aria-busy={mode === 'sending'}
        data-mode={mode}
        disabled={disabled || mode === 'sending'}
        className={cx(
          buttonClass(mode === 'stop' ? 'secondary' : 'primary', 'sm', { square: true }),
          'relative overflow-hidden rounded-full disabled:opacity-40',
          mode === 'sending' && 'disabled:opacity-100',
        )}
      >
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={mode}
            className="flex"
            initial={{ opacity: 0, transform: move(still, 'scale(0.6)'), filter: 'blur(2px)' }}
            animate={{ opacity: 1, transform: move(still, 'scale(1)'), filter: 'blur(0px)' }}
            exit={{
              opacity: 0,
              transform: move(still, mode === 'send' ? 'translateY(-8px)' : 'scale(0.6)'),
              filter: 'blur(2px)',
              transition: { duration: dur.fast, ease: ease.out },
            }}
            transition={spring.snappy}
          >
            {icon}
          </motion.span>
        </AnimatePresence>
      </button>
    </Tooltip>
  );
}

/** Statuses in which Claude's TUI is mid-turn: input would land half-typed, Esc stops it. */
const TERMINAL_BUSY = new Set<ClaudeSession['status']['kind']>(['working', 'tool', 'compacting']);

/**
 * A terminal session at the board (F14): the normal composer, sending each message as a line typed
 * at Claude's prompt in its terminal. While Claude works it can only be stopped (Esc, as in the
 * TUI); while it asks for permission, only the approval is offered. Without a linked terminal, or
 * with the setting off, the board can still continue it as a fork.
 */
function TerminalSessionComposer({ session }: { session: ClaudeSession }) {
  const client = useBoardClient();
  const settings = useBoardSettings().settings;
  // On by default: until the settings load, assume it is.
  const replyEnabled = settings?.terminalReply ?? true;
  const fork = useFork(session);
  if (!replyEnabled || session.terminalId === null || !isSessionLive(session.status)) {
    return <ForkBar session={session} fork={fork} />;
  }
  const terminalId = session.terminalId;
  if (session.status.kind === 'waiting_permission') {
    return <TerminalApproval session={session} terminalId={terminalId} />;
  }
  const busy = TERMINAL_BUSY.has(session.status.kind);
  const ready = terminalReplyBlock(session) === null;

  return (
    <Composer
      key={session.id}
      label={`Message ${session.title ?? 'Claude'}`}
      placeholder={ready ? 'Reply to Claude…' : 'Claude is working, reply when it’s idle'}
      running={busy}
      sendBlocked={!ready}
      model={session.model}
      permissionMode={session.permissionMode}
      hint={busy ? 'Esc to stop' : 'Sent to the terminal'}
      menu={<ComposerMenu fork={fork} />}
      onModel={() => {}}
      onPermissionMode={() => {}}
      onSend={async (text) => {
        const result = await client.action({
          kind: 'session.replyInTerminal',
          sessionId: session.id,
          text,
        });
        if (!result.ok) toast.error(errorText(result.error, 'Could not send to the terminal'));
        return result.ok;
      }}
      onInterrupt={async () => {
        const result = await client.action({
          kind: 'terminal.sendText',
          terminalId,
          text: ESC,
          execute: false,
        });
        if (!result.ok) toast.error(errorText(result.error, 'Could not interrupt Claude'));
      }}
    />
  );
}

interface Fork {
  forking: boolean;
  start: () => Promise<void>;
}

/** Continues a terminal session as a board session that starts from its conversation. */
function useFork(session: ClaudeSession): Fork {
  const client = useBoardClient();
  const [, navigate] = useLocation();
  const [forking, setForking] = useState(false);
  const start = async () => {
    setForking(true);
    const result = await client.action({
      kind: 'session.resume',
      sessionId: session.id,
      fork: true,
      ...(session.projectId ? { projectId: session.projectId } : {}),
    });
    setForking(false);
    if (!result.ok) {
      toast.error(errorText(result.error, 'Could not fork the session'));
      return;
    }
    if (result.sessionId && session.projectId) {
      navigate(sessionHref(session.projectId, result.sessionId));
    }
  };
  return { forking, start };
}

function ForkIcon({ forking }: { forking: boolean }) {
  return forking ? (
    <LoaderCircle className="hud-spin size-3.5" strokeWidth={1.5} />
  ) : (
    <GitFork className="size-3.5" strokeWidth={1.5} />
  );
}

/** The terminal composer's secondary actions: for now, the fork. */
function ComposerMenu({ fork }: { fork: Fork }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="More actions"
      side="top"
      align="start"
      className="flex w-72 max-w-[calc(100vw-32px)] flex-col gap-2"
      data-composer-menu
      trigger={
        <IconButton
          size="sm"
          label="More actions"
          aria-expanded={open}
          icon={<Ellipsis className="size-4" strokeWidth={1.5} />}
          tooltipSide="top"
        />
      }
    >
      <button
        type="button"
        disabled={fork.forking}
        aria-busy={fork.forking}
        onClick={() => void fork.start().then(() => setOpen(false))}
        className="flex min-w-0 items-start gap-2.5 rounded-control px-2 py-1.5 text-left transition-colors duration-fast hover:bg-bg-2 disabled:opacity-50"
      >
        <span className="mt-0.5 flex shrink-0 text-text-2">
          <ForkIcon forking={fork.forking} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-body-sm text-text-1">Resume here (fork)</span>
          <span className="text-meta text-text-2">
            A board session that starts from this conversation. It won't see what happens in the
            terminal next.
          </span>
        </span>
      </button>
    </Popover>
  );
}

/**
 * Where the board can't type into the terminal (no linked terminal, the session ended, or the
 * setting is off), it continues the session as a fork.
 */
function ForkBar({ session, fork }: { session: ClaudeSession; fork: Fork }) {
  const live = isSessionLive(session.status);
  const column = chatColumn(useCompactChat());
  return (
    <div data-fork-bar className={column.dock}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-control border border-line bg-bg-2 px-3 py-2.5 shadow-raised">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 basis-56 text-body-sm text-text-2">
            This session runs in a terminal. Continue it here as a board session that starts from
            this conversation.
          </p>
          <button
            type="button"
            onClick={() => void fork.start()}
            disabled={fork.forking}
            aria-busy={fork.forking}
            className={buttonClass('primary', 'sm')}
          >
            <ForkIcon forking={fork.forking} />
            Resume here (fork)
          </button>
        </div>
        {live && (
          <p role="note" className="flex min-w-0 items-start gap-1.5 text-meta text-text-2">
            <TriangleAlert
              aria-hidden
              className="mt-px size-3.5 shrink-0 text-st-wait"
              strokeWidth={1.5}
            />
            The original is still running in its terminal. The fork continues separately and won't
            see what happens there next.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * A permission prompt is open in the terminal: free text would answer it, so none is sent. With
 * the request routed to the board (away mode) it is decided here; otherwise in the terminal.
 */
function TerminalApproval({ session, terminalId }: { session: ClaudeSession; terminalId: string }) {
  const approvalId =
    session.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const column = chatColumn(useCompactChat());
  return (
    <div data-terminal-approval className={column.dock}>
      <div className="mx-auto w-full max-w-3xl">
        {approval?.state === 'pending' ? (
          <InlineApproval approval={approval} />
        ) : (
          <AnswerInTerminal session={session} terminalId={terminalId} />
        )}
      </div>
    </div>
  );
}

function InlineApproval({ approval }: { approval: Approval }) {
  const client = useBoardClient();
  const [denying, setDenying] = useState(false);
  const [busy, setBusy] = useState(false);
  const decide = async (decision: AttentionDecision, reason?: string) => {
    if (busy) return;
    if (decision === 'allowAlways' && !canAlwaysAllow(approval)) return;
    setBusy(true);
    const result = await client.request(
      'approval.decide',
      decision === 'deny'
        ? { approvalId: approval.id, decision, ...(reason ? { reason } : {}) }
        : { approvalId: approval.id, decision },
    );
    setBusy(false);
    if (!result.ok) toast.error(actionErrorText(result.error, 'The decision did not go through'));
  };
  return (
    <ApprovalCard
      approval={approval}
      resolved={null}
      selected
      denying={denying}
      busy={busy}
      onSelect={() => {}}
      onDecide={(decision, reason) => void decide(decision, reason)}
      onDenyStart={() => setDenying(true)}
      onDenyCancel={() => setDenying(false)}
    />
  );
}

function AnswerInTerminal({ session, terminalId }: { session: ClaudeSession; terminalId: string }) {
  const client = useBoardClient();
  const editor = useBoard((s) => {
    const windowId = s.board.terminals[terminalId]?.windowId;
    return (windowId && s.board.windows[windowId]?.appName) || 'Cursor';
  });
  const tool = session.currentTool?.tool ?? null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-st-wait/40 bg-bg-2 px-3 py-2.5 shadow-raised">
      <p className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <span className="font-medium text-body-sm text-st-wait-ink">
          Answer in the terminal{tool ? `: ${tool}` : ''}
        </span>
        <span className="text-meta text-text-2">
          Claude is asking for permission at its prompt. Turn on away mode in Settings to decide
          requests here.
        </span>
      </p>
      <button
        type="button"
        className={buttonClass('primary', 'sm')}
        onClick={async () => {
          const result = await client.action({ kind: 'terminal.focus', terminalId });
          if (!result.ok) toast.error(actionErrorText(result.error));
        }}
      >
        <ExternalLink className="size-3.5" strokeWidth={1.5} />
        Focus in {editor}
      </button>
    </div>
  );
}
