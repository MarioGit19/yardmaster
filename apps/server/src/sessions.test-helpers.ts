import { SESSION_HEADER } from '@yardmaster/protocol';
import type { FastifyInstance } from 'fastify';

/** Signs a fresh browser on this machine in, as `/auth?c=` would, and returns its header. */
export function sessionHeader(app: FastifyInstance, userAgent?: string): Record<string, string> {
  return { [SESSION_HEADER]: app.browserSessions.create('local', userAgent).secret };
}
