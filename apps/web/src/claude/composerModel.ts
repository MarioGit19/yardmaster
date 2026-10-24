import type { ClaudeSession, PermissionMode } from '@yardmaster/protocol';

/** Model aliases the composer offers; `''` leaves the choice to Claude Code's settings. */
export const MODEL_OPTIONS = [
  { value: '', label: 'Default model' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
] as const;

export const PERMISSION_OPTIONS: readonly { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask first' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan only' },
  { value: 'auto', label: 'Auto' },
  { value: 'dontAsk', label: "Don't ask" },
  { value: 'bypassPermissions', label: 'Bypass' },
];

const FAMILY = /(opus|sonnet|haiku)(?:-(\d+)(?:-(\d+))?)?/;

/** `claude-opus-5-5` → `Opus 5.5`, `sonnet` → `Sonnet`; unknown ids lose only the prefix. */
export function modelLabel(model: string | null): string {
  if (!model) return 'Default model';
  const match = FAMILY.exec(model);
  if (!match?.[1]) return model.replace(/^claude-/, '');
  const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const version = [match[2], match[3]].filter(Boolean).join('.');
  return version ? `${name} ${version}` : name;
}

/** The model picker's value for a session's model: its family alias, or the id itself. */
export function modelValue(model: string | null): string {
  if (!model) return '';
  return FAMILY.exec(model)?.[1] ?? model;
}

export function permissionLabel(mode: PermissionMode | null): string {
  return PERMISSION_OPTIONS.find((o) => o.value === (mode ?? 'default'))?.label ?? 'Ask first';
}

/** A turn is under way: the composer offers Stop and Esc interrupts. */
export function isTurnRunning(status: ClaudeSession['status']): boolean {
  return ['working', 'tool', 'compacting', 'waiting_permission'].includes(status.kind);
}

/** The original of a terminal session may still be writing its transcript. */
export function isSessionLive(status: ClaudeSession['status']): boolean {
  if (status.kind === 'ended' || status.kind === 'interrupted') return false;
  if (status.kind === 'unknown') return status.alive;
  return true;
}

/**
 * The phone composer's state as a sentence (DESIGN.md §11): what Claude is doing and what a reply
 * does now. `queues`: a board session takes a follow-up mid-turn; a terminal one waits.
 */
export function composerSentence(status: ClaudeSession['status'], queues: boolean): string {
  switch (status.kind) {
    case 'working':
    case 'tool':
    case 'compacting':
      return queues
        ? 'Claude is working. A reply waits until it’s done.'
        : 'Claude is working, you can reply when it’s done.';
    case 'waiting_permission':
      return 'Claude is waiting for your approval.';
    case 'waiting_input':
      return 'Claude is waiting for your answer.';
    case 'error':
      return 'Claude stopped with an error. A reply tries again.';
    default:
      return 'Claude is idle. Reply to carry on.';
  }
}

export type SendButtonMode = 'send' | 'sending' | 'stop';

/** Stop while a turn runs and nothing is typed; otherwise send (a typed prompt queues). */
export function sendButtonMode(state: {
  sending: boolean;
  running: boolean;
  text: string;
}): SendButtonMode {
  if (state.sending) return 'sending';
  if (state.running && state.text.trim() === '') return 'stop';
  return 'send';
}

export type ComposerKey = 'send' | 'interrupt' | null;

/** Enter sends, Shift+Enter is a newline, Esc interrupts a running turn. IME input is left alone. */
export function composerKey(
  e: { key: string; shiftKey: boolean; isComposing: boolean },
  running: boolean,
): ComposerKey {
  if (e.isComposing) return null;
  if (e.key === 'Enter' && !e.shiftKey) return 'send';
  if (e.key === 'Escape' && running) return 'interrupt';
  return null;
}
