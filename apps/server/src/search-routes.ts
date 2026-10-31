import {
  type SearchIndexStatus,
  SearchRequest,
  type SearchResponse,
  SearchTranscriptRequest,
  SessionId,
} from '@yardmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TranscriptIndex } from './claude/transcript-index.js';
import { localOnly } from './security.js';

const SessionParams = z.object({ sessionId: SessionId });

/**
 * Search over every transcript. All under `/api`, so the auth guard covers them; nothing here
 * leaves the machine. Rebuilding and clearing delete history, so a phone can't.
 */
export function registerSearchRoutes(app: FastifyInstance, index: TranscriptIndex): void {
  app.get('/api/search', async (request, reply) => {
    const query = SearchRequest.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'bad_request' });
    reply.header('cache-control', 'no-store');
    return index.search(query.data) satisfies SearchResponse;
  });

  app.get('/api/search/index', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return index.status() satisfies SearchIndexStatus;
  });

  app.post('/api/search/index/rebuild', { preHandler: localOnly }, async () => {
    index.rebuild();
    return { ok: true };
  });

  app.delete('/api/search/index', { preHandler: localOnly }, async () => {
    index.clear();
    return { ok: true };
  });

  app.get('/api/search/sessions/:sessionId', async (request, reply) => {
    const params = SessionParams.safeParse(request.params);
    const query = SearchTranscriptRequest.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'bad_request' });
    reply.header('cache-control', 'no-store');
    const transcript = await index.transcript(params.data.sessionId, query.data.around);
    return transcript ?? reply.code(404).send({ error: 'unknown_session' });
  });
}
