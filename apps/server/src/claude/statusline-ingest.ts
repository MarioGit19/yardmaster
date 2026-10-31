import {
  type AccountUsage,
  LOCAL_ROUTES,
  meterFromStatusline,
  StatuslinePayload,
  usageFromStatusline,
} from '@yardmaster/protocol';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { BoardStore } from '../store.js';

/** The whole statusline JSON comes through; it's small. */
export const STATUSLINE_BODY_LIMIT = 256 * 1024;

export interface StatuslineIngestOptions {
  store: BoardStore;
  logger: Pick<FastifyBaseLogger, 'warn'>;
  /** Off in demo mode: deliveries are counted but the synthetic board is left alone. */
  apply: boolean;
  /** Called when the limits themselves changed, so the last reading survives a restart. */
  onUsage(usage: AccountUsage): void;
  /** Called for every delivery, valid or not. */
  onReceived(ts: number): void;
  now?: () => number;
}

const sameWindows = (a: AccountUsage | null | undefined, b: AccountUsage) =>
  JSON.stringify([a?.fiveHour, a?.sevenDay]) === JSON.stringify([b.fiveHour, b.sevenDay]);

/** Applies one forwarded statusline. Never throws. */
export function ingestStatusline(raw: unknown, options: StatuslineIngestOptions): void {
  const { store, logger, apply, onUsage, onReceived, now = Date.now } = options;
  const ts = now();
  onReceived(ts);
  const payload = StatuslinePayload.safeParse(raw);
  if (!payload.success) {
    logger.warn({ issues: payload.error.issues.length }, 'skipping malformed statusline');
    return;
  }
  if (!apply) return;

  // A delivery without limits says nothing: a new session has none until its first reply.
  const usage = usageFromStatusline(payload.data, ts);
  if (usage) {
    const changed = !sameWindows(store.state.usage, usage);
    store.setUsage(usage);
    if (changed) onUsage(usage);
  }

  const id = payload.data.session_id;
  const session = id ? store.state.sessions[id] : undefined;
  if (!session) return;
  const meter = meterFromStatusline(payload.data);
  if (JSON.stringify(session.meter) === JSON.stringify(meter)) return;
  // Not activity: the statusline redraws on its own, and mustn't reorder anything.
  store.updateSession(session.id, { meter, updatedAt: session.updatedAt });
}

/** `POST /api/hooks/statusline`, on the local socket with the token. Replies 204 at once. */
export function registerStatuslineRoute(
  app: FastifyInstance,
  options: StatuslineIngestOptions,
): void {
  app.post(
    LOCAL_ROUTES.statusline,
    { bodyLimit: STATUSLINE_BODY_LIMIT },
    async (request, reply) => {
      ingestStatusline(request.body, options);
      return reply.code(204).send();
    },
  );
}
