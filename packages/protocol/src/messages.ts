import { z } from 'zod';
import {
  ActivityEvent,
  Approval,
  ApprovalId,
  ApprovalState,
  BoardState,
  CommandConfidence,
  EditorCapabilities,
  ExecutionId,
  PermissionMode,
  Pid,
  ProjectId,
  SessionId,
  TerminalId,
  TerminalState,
  Timestamp,
  WindowId,
} from './domain.js';
import { PatchOp } from './patch.js';

// Wire messages, PRD §7. Every message is an envelope `{ v: 1, type, id?, ts, payload }`.

export const PROTOCOL_VERSION = 1;

export const MessageId = z.string().min(1).max(128);

const Text = z.string().max(100_000);
const ShortText = z.string().max(1_000);
const Path = z.string().min(1).max(4_096);

function envelope<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    id: MessageId.optional(),
    ts: Timestamp,
    payload,
  });
}

/** Commands need an id so the reply can be correlated. */
function command<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return envelope(type, payload).extend({ id: MessageId });
}

// Editor → server (`/ws/editor`)

/** Close code sent to an editor socket when a newer connection for its window takes over. */
export const EDITOR_CLOSE_REPLACED = 4001;

export const EditorTerminal = z.object({
  terminalId: TerminalId,
  name: z.string().max(256),
  shellPid: Pid.nullable(),
  cwd: Path.nullable(),
  state: TerminalState,
  shellIntegration: z.boolean(),
  active: z.boolean(),
  exitCode: z.number().int().nullable(),
});
export type EditorTerminal = z.infer<typeof EditorTerminal>;

export const EditorHello = envelope(
  'editor.hello',
  z.object({
    windowId: WindowId,
    appName: z.string().max(128),
    appVersion: z.string().max(64),
    workspaceFolders: z.array(Path).max(256),
    extensionVersion: z.string().max(64),
    capabilities: EditorCapabilities,
  }),
);
export const TerminalUpsert = envelope('terminal.upsert', EditorTerminal);
/** The window's full terminal list (sent after every connect); terminals not in it are gone. */
export const TerminalSync = envelope(
  'terminal.sync',
  z.object({ terminals: z.array(EditorTerminal).max(1_000) }),
);
export const TerminalClosed = envelope(
  'terminal.closed',
  z.object({ terminalId: TerminalId, exitCode: z.number().int().nullable() }),
);
export const ExecStart = envelope(
  'exec.start',
  z.object({
    execId: ExecutionId,
    terminalId: TerminalId,
    commandLine: Text,
    confidence: CommandConfidence,
    cwd: Path.nullable(),
  }),
);
/** Batched by the extension every ≤ 50 ms or 16 KB. */
export const ExecData = envelope(
  'exec.data',
  z.object({
    execId: ExecutionId,
    seq: z.number().int().nonnegative(),
    chunk: z.string().max(64 * 1024),
  }),
);
/** The execution entered the alternate screen; it is rendered as an interactive app. */
export const ExecInteractive = envelope('exec.interactive', z.object({ execId: ExecutionId }));
export const ExecEnd = envelope(
  'exec.end',
  z.object({ execId: ExecutionId, exitCode: z.number().int().nullable() }),
);
export const EditorHeartbeat = envelope('editor.heartbeat', z.object({}));
/** Reply to a server command; `id` is the command's envelope id. */
export const CmdResult = envelope(
  'cmd.result',
  z.object({ id: MessageId, ok: z.boolean(), error: ShortText.optional() }),
);

export const EditorToServer = z.discriminatedUnion('type', [
  EditorHello,
  TerminalUpsert,
  TerminalSync,
  TerminalClosed,
  ExecStart,
  ExecData,
  ExecInteractive,
  ExecEnd,
  EditorHeartbeat,
  CmdResult,
]);
export type EditorToServer = z.infer<typeof EditorToServer>;

// Server → editor

export const CmdSendText = command(
  'cmd.sendText',
  z.object({ terminalId: TerminalId, text: Text, execute: z.boolean() }),
);
export const CmdInterrupt = command('cmd.interrupt', z.object({ terminalId: TerminalId }));
export const CmdCreateTerminal = command(
  'cmd.createTerminal',
  z.object({ cwd: Path, name: z.string().min(1).max(256), command: Text.optional() }),
);
export const CmdFocusTerminal = command('cmd.focusTerminal', z.object({ terminalId: TerminalId }));
export const CmdDisposeTerminal = command(
  'cmd.disposeTerminal',
  z.object({ terminalId: TerminalId }),
);
export const CmdRerun = command('cmd.rerun', z.object({ execId: ExecutionId }));

export const ServerToEditor = z.discriminatedUnion('type', [
  CmdSendText,
  CmdInterrupt,
  CmdCreateTerminal,
  CmdFocusTerminal,
  CmdDisposeTerminal,
  CmdRerun,
]);
export type ServerToEditor = z.infer<typeof ServerToEditor>;

// Server → UI (`/ws/ui`)

/** `exec:<execId>`, `term:<terminalId>` or `transcript:<sessionId>` (chunks are `ChatMessage` JSON). */
export const StreamId = z.string().regex(/^(exec|term|transcript):[^\s]{1,256}$/);
export type StreamId = z.infer<typeof StreamId>;

export const ToastLevel = z.enum(['info', 'success', 'warning', 'error']);
export type ToastLevel = z.infer<typeof ToastLevel>;

export const Snapshot = envelope('snapshot', z.object({ state: BoardState }));
/** Coalesced to ≤ 30 per second. */
export const Patch = envelope('patch', z.object({ ops: z.array(PatchOp) }));
export const StreamData = envelope(
  'stream.data',
  z.object({ streamId: StreamId, seq: z.number().int().nonnegative(), chunk: z.string() }),
);
/**
 * Live output for the stream was dropped (the client fell behind). The server stops
 * streaming it; the client re-subscribes with `fromSeq` to replay from the buffer.
 */
export const StreamResync = envelope(
  'stream.resync',
  z.object({ streamId: StreamId, fromSeq: z.number().int().nonnegative() }),
);
export const Toast = envelope(
  'toast',
  z.object({
    level: ToastLevel,
    title: ShortText.min(1),
    body: ShortText.optional(),
    projectId: ProjectId.optional(),
    sessionId: SessionId.optional(),
  }),
);
/** How far back the Pulse rail looks; the server replays this window on connect. */
export const PULSE_WINDOW_MS = 15 * 60_000;
/**
 * Activity events for the Pulse rail. `replace` carries the recent window on connect and
 * replaces what the client holds; later batches append.
 */
export const ActivityBatch = envelope(
  'activity',
  z.object({ events: z.array(ActivityEvent).max(5_000), replace: z.boolean() }),
);
export const ApprovalNew = envelope('approval.new', z.object({ approval: Approval }));
export const ApprovalResolved = envelope(
  'approval.resolved',
  z.object({ approvalId: ApprovalId, state: ApprovalState, reason: ShortText.nullable() }),
);

/** Reply to a UI message that carried an envelope `id`. */
export const ActionResult = envelope(
  'action.result',
  z.object({ id: MessageId, ok: z.boolean(), error: ShortText.optional() }),
);

export const ServerToUi = z.discriminatedUnion('type', [
  Snapshot,
  Patch,
  StreamData,
  StreamResync,
  ActionResult,
  Toast,
  ActivityBatch,
  ApprovalNew,
  ApprovalResolved,
]);
export type ServerToUi = z.infer<typeof ServerToUi>;

// UI → server

const action = <K extends string, S extends z.ZodRawShape>(kind: K, shape: S) =>
  z.object({ kind: z.literal(kind), ...shape });

/** Every user action from the board (F3, F6, F10, F13). */
export const UiAction = z.discriminatedUnion('kind', [
  action('terminal.sendText', { terminalId: TerminalId, text: Text, execute: z.boolean() }),
  action('terminal.interrupt', { terminalId: TerminalId }),
  action('terminal.rerun', { execId: ExecutionId }),
  action('terminal.create', {
    projectId: ProjectId,
    name: z.string().min(1).max(256).optional(),
    command: Text.optional(),
  }),
  action('terminal.focus', { terminalId: TerminalId }),
  action('terminal.close', { terminalId: TerminalId }),
  action('session.create', {
    projectId: ProjectId,
    prompt: Text.min(1),
    model: z.string().min(1).max(128).optional(),
    permissionMode: PermissionMode.optional(),
  }),
  action('session.resume', { sessionId: SessionId, fork: z.boolean().optional() }),
  /** Opens a terminal in the project's editor window running `claude --resume <id>` (F17). */
  action('session.resumeInEditor', { projectId: ProjectId, sessionId: SessionId }),
  action('session.interrupt', { sessionId: SessionId }),
  action('session.close', { sessionId: SessionId }),
  action('session.setModel', { sessionId: SessionId, model: z.string().min(1).max(128) }),
  action('session.setPermissionMode', { sessionId: SessionId, permissionMode: PermissionMode }),
  action('project.add', { path: Path }),
  action('project.remove', { projectId: ProjectId }),
  action('project.openInEditor', { projectId: ProjectId }),
  action('settings.set', { key: z.string().min(1).max(128), value: z.unknown() }),
]);
export type UiAction = z.infer<typeof UiAction>;
export type UiActionKind = UiAction['kind'];

export const ApprovalDecision = z.discriminatedUnion('decision', [
  z.object({ approvalId: ApprovalId, decision: z.literal('allow') }),
  z.object({ approvalId: ApprovalId, decision: z.literal('allowAlways') }),
  z.object({ approvalId: ApprovalId, decision: z.literal('deny'), reason: ShortText.optional() }),
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const Subscribe = envelope(
  'subscribe',
  z.object({ streamId: StreamId, fromSeq: z.number().int().nonnegative().optional() }),
);
export const Unsubscribe = envelope('unsubscribe', z.object({ streamId: StreamId }));
export const Action = envelope('action', UiAction);
export const SessionSend = envelope(
  'session.send',
  z.object({ sessionId: SessionId, text: Text.min(1) }),
);
export const ApprovalDecide = envelope('approval.decide', ApprovalDecision);

export const UiToServer = z.discriminatedUnion('type', [
  Subscribe,
  Unsubscribe,
  Action,
  SessionSend,
  ApprovalDecide,
]);
export type UiToServer = z.infer<typeof UiToServer>;

export const Message = z.union([EditorToServer, ServerToEditor, ServerToUi, UiToServer]);
export type Message = z.infer<typeof Message>;

// Codec

export type DecodeResult<T> = { ok: true; message: T } | { ok: false; reason: string };
export type EncodeResult = { ok: true; data: string } | { ok: false; reason: string };

/** Typed constructor for a message of a given union, filling in `v` and `ts`. */
export function makeMessage<M extends { type: string; payload: unknown; id?: string }>(
  type: M['type'],
  payload: M['payload'],
  opts: { id?: string; ts?: number } = {},
): M {
  const msg: Record<string, unknown> = {
    v: PROTOCOL_VERSION,
    type,
    ts: opts.ts ?? Date.now(),
    payload,
  };
  if (opts.id !== undefined) msg.id = opts.id;
  return msg as M;
}

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${at}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Validates and parses an incoming message. Accepts raw JSON text or an already parsed value.
 * Never throws: bad input comes back as `{ ok: false, reason }`.
 */
export function decode<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  opts: { maxLength?: number } = {},
): DecodeResult<z.output<S>> {
  let value = raw;
  if (typeof raw === 'string') {
    if (opts.maxLength !== undefined && raw.length > opts.maxLength) {
      return { ok: false, reason: `message longer than ${opts.maxLength} characters` };
    }
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'invalid JSON' };
    }
  }
  const result = schema.safeParse(value);
  if (!result.success) return { ok: false, reason: describe(result.error) };
  return { ok: true, message: result.data };
}

/** Validates an outgoing message and serializes it. Never throws. */
export function encode<S extends z.ZodType>(schema: S, message: z.input<S>): EncodeResult {
  const result = schema.safeParse(message);
  if (!result.success) return { ok: false, reason: describe(result.error) };
  try {
    return { ok: true, data: JSON.stringify(result.data) };
  } catch {
    return { ok: false, reason: 'not serializable' };
  }
}

export const decodeEditorToServer = (raw: unknown, opts?: { maxLength?: number }) =>
  decode(EditorToServer, raw, opts);
export const decodeServerToEditor = (raw: unknown, opts?: { maxLength?: number }) =>
  decode(ServerToEditor, raw, opts);
export const decodeServerToUi = (raw: unknown, opts?: { maxLength?: number }) =>
  decode(ServerToUi, raw, opts);
export const decodeUiToServer = (raw: unknown, opts?: { maxLength?: number }) =>
  decode(UiToServer, raw, opts);

export const encodeEditorToServer = (message: EditorToServer) => encode(EditorToServer, message);
export const encodeServerToEditor = (message: ServerToEditor) => encode(ServerToEditor, message);
export const encodeServerToUi = (message: ServerToUi) => encode(ServerToUi, message);
export const encodeUiToServer = (message: UiToServer) => encode(UiToServer, message);
