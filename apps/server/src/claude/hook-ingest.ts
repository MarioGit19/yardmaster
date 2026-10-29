import {
  type ActivityEvent,
  HookCommon,
  KnownHookEvent,
  LOCAL_ROUTES,
  normalizeHookEvent,
  Pid,
} from '@yardmaster/protocol';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { headerValue, LEGACY_CLAUDE_PID_HEADER } from '../legacy.js';
import type { BoardStore } from '../store.js';
import { type PathResolver, projectForCwd, resolveDir } from './project-lookup.js';
import { sessionReducer } from './session-reducer.js';

export const HOOK_ROUTE = LOCAL_ROUTES.hooks;
export const CLAUDE_PID_HEADER = 'x-yardmaster-claude-pid';

/** The hook's Claude pid header, also under its old name for one version. */
export function claudePidHeader(headers: Record<string, string | string[] | undefined>) {
  return headerValue(headers, CLAUDE_PID_HEADER, LEGACY_CLAUDE_PID_HEADER);
}
/** Write and Edit inputs can carry whole files. */
export const HOOK_BODY_LIMIT = 4 * 1024 * 1024;

export interface HookIngestOptions {
  store: BoardStore;
  logger: Pick<FastifyBaseLogger, 'warn' | 'debug'>;
  onActivity?: (event: ActivityEvent) => void;
  /** Called after a `PostToolUse` event has been applied. */
  onToolDone?: (tool: string, projectId: string | null) => void;
  /** Called for every delivery, valid or not. */
  onReceived?: (ts: number) => void;
  /** Off in demo mode: hooks are counted but the synthetic board is left alone. */
  apply?: boolean;
  now?: () => number;
  resolvePath?: PathResolver;
}

/**
 * Applies Claude Code hook deliveries to the store, one at a time in arrival order
 * so the async project lookup can't reorder a session's events.
 */
export class HookIngest {
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly resolvePath: PathResolver;

  constructor(private readonly options: HookIngestOptions) {
    this.now = options.now ?? Date.now;
    this.resolvePath = options.resolvePath ?? resolveDir;
  }

  /** Queues a raw payload. Never throws. */
  enqueue(raw: unknown, claudePid: number | null): Promise<void> {
    const ts = this.now();
    this.options.onReceived?.(ts);
    this.queue = this.queue
      .then(() => this.process(raw, claudePid, ts))
      .catch((err: unknown) => this.options.logger.warn({ err }, 'hook event failed'));
    return this.queue;
  }

  /** Resolves once every queued event has been applied. */
  idle(): Promise<void> {
    return this.queue;
  }

  private async process(raw: unknown, claudePid: number | null, ts: number): Promise<void> {
    const common = HookCommon.safeParse(raw);
    if (!common.success) {
      this.options.logger.warn({ issues: common.error.issues.length }, 'skipping malformed hook');
      return;
    }
    if (this.options.apply === false) return;

    const known = KnownHookEvent.safeParse(raw);
    if (!known.success) {
      this.options.logger.debug({ event: common.data.hook_event_name }, 'unrecognised hook event');
    }
    const cwd = common.data.cwd;
    const projectId = cwd
      ? await projectForCwd(this.options.store, cwd, ts, this.resolvePath)
      : null;

    const { store } = this.options;
    const session = sessionReducer(store.state.sessions[common.data.session_id], {
      common: common.data,
      hook: known.success ? known.data : null,
      ts,
      claudePid,
      projectId,
    });
    store.upsertSession(session);

    const activity = normalizeHookEvent(raw, claudePid, { now: ts });
    this.options.onActivity?.({
      ...activity,
      projectId: session.projectId,
      data: compactData(activity.data),
    });
    if (known.success && known.data.hook_event_name === 'PostToolUse') {
      this.options.onToolDone?.(known.data.tool_name, session.projectId);
    }
  }
}

const MAX_INPUT_STRING = 1_000;
const MAX_INPUT_JSON = 16 * 1024;

/** Activity rows keep a trimmed copy of `tool_input`: Write and Edit can carry whole files. */
function compactData(data: Record<string, unknown>): Record<string, unknown> {
  const input = data.toolInput;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return data;
  const trimmed = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === 'string' && value.length > MAX_INPUT_STRING
        ? `${value.slice(0, MAX_INPUT_STRING - 1)}…`
        : value,
    ]),
  );
  const fits = JSON.stringify(trimmed).length <= MAX_INPUT_JSON;
  return { ...data, toolInput: fits ? trimmed : null };
}

export function parseClaudePid(header: string | string[] | undefined): number | null {
  if (typeof header !== 'string' || !/^\d{1,10}$/.test(header.trim())) return null;
  const pid = Pid.safeParse(Number(header.trim()));
  return pid.success ? pid.data : null;
}

/**
 * `POST /api/hooks/claude`, on the local socket with the token. Replies 204 at once; the event is
 * applied after the response so the hook script never waits on the board.
 */
export function registerHookRoute(app: FastifyInstance, ingest: HookIngest): void {
  app.post(HOOK_ROUTE, { bodyLimit: HOOK_BODY_LIMIT }, async (request, reply) => {
    const pid = parseClaudePid(claudePidHeader(request.headers));
    const body = request.body;
    reply.code(204).send();
    setImmediate(() => void ingest.enqueue(body, pid));
  });
}
