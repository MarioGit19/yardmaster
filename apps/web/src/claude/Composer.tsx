import type { ClaudeSession, PermissionMode } from '@c-board/protocol';
import {
  ArrowUp,
  ChevronDown,
  Cpu,
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
import { useBoardClient } from '../data/index.js';
import { dur, ease, spring } from '../motion.js';
import { sessionHref } from '../routes.js';
import { actionErrorText } from '../terminal/stack.js';
import { buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
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

const ERRORS: Record<string, string> = {
  session_not_running: 'The session is not running',
  session_live: 'The session is still running in its terminal',
  unknown_session: 'The session is gone',
  unknown_project: 'The project is gone',
};
const errorText = (code: string, fallback: string) =>
  ERRORS[code] ?? actionErrorText(code, fallback);

/** The Claude panel's input for a session: a board session's composer, or a terminal's fork bar. */
export function SessionComposer({ session }: { session: ClaudeSession }) {
  if (session.origin === 'terminal') return <ForkBar session={session} />;
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
}: ComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mode = sendButtonMode({ sending, running, text });

  const send = async () => {
    const prompt = text.trim();
    if (!prompt || sending) return;
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
      className="shrink-0 px-5 pt-2 pb-4"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-control border border-line bg-bg-2 px-3 pt-2.5 pb-2 shadow-raised transition-[border-color] duration-150 focus-within:border-line-strong">
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
          <span className="ml-auto hidden truncate text-meta text-text-3 xl:block">
            {running ? 'Esc to stop' : 'Shift+Enter for a new line'}
          </span>
          <SendButton mode={mode} disabled={mode === 'send' && text.trim() === ''} />
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
        'relative inline-flex h-6 min-w-0 items-center gap-1.5 rounded-chip border border-line bg-bg-1 px-2 text-label text-text-2 transition-[border-color,color] duration-150',
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
            initial={{ opacity: 0, transform: 'scale(0.6)', filter: 'blur(2px)' }}
            animate={{ opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' }}
            exit={{
              opacity: 0,
              transform: mode === 'send' ? 'translateY(-8px)' : 'scale(0.6)',
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

/**
 * Terminal sessions are driven from their terminal; the board continues them as a fork
 * (`forkSession`), a new session that starts from this conversation.
 */
function ForkBar({ session }: { session: ClaudeSession }) {
  const client = useBoardClient();
  const [, navigate] = useLocation();
  const [forking, setForking] = useState(false);
  const live = isSessionLive(session.status);

  const fork = async () => {
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

  return (
    <div data-fork-bar className="shrink-0 px-5 pt-2 pb-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-control border border-line bg-bg-2 px-3 py-2.5 shadow-raised">
        <div className="flex min-w-0 items-center gap-3">
          <p className="min-w-0 flex-1 text-body-sm text-text-2">
            This session runs in a terminal. Continue it here as a board session that starts from
            this conversation.
          </p>
          <button
            type="button"
            onClick={() => void fork()}
            disabled={forking}
            aria-busy={forking}
            className={buttonClass('primary', 'sm')}
          >
            {forking ? (
              <LoaderCircle className="hud-spin size-3.5" strokeWidth={1.5} />
            ) : (
              <GitFork className="size-3.5" strokeWidth={1.5} />
            )}
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
