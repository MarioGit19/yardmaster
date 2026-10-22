import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** `apps/web/dist`, resolved from both `src/` (tsx) and `dist/` (built). */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web/dist', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** Paths owned by the server; they never fall back to the SPA. */
const RESERVED = /^\/(api|ws|auth)(\/|$)/;

export function hasWebBuild(root: string): boolean {
  return existsSync(resolve(root, 'index.html'));
}

/** Resolves a request path inside `root`, or undefined for anything that would escape it. */
export function resolveAssetPath(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const base = resolve(root);
  const target = resolve(base, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`);
  return target === base || target.startsWith(base + sep) ? target : undefined;
}

async function sendFile(reply: FastifyReply, path: string, cacheControl: string) {
  const info = await stat(path);
  return reply
    .header(
      'content-type',
      CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    )
    .header('content-length', info.size)
    .header('cache-control', cacheControl)
    .header('x-content-type-options', 'nosniff')
    .send(createReadStream(path));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves the built web app with an SPA fallback: unknown extension-less paths get
 * `index.html`, so client routes survive a reload. Hashed files under `/assets/` are immutable.
 * Returns false (and registers nothing) when `root` has no `index.html`.
 */
export function registerStatic(app: FastifyInstance, root: string): boolean {
  if (!hasWebBuild(root)) return false;
  const index = resolve(root, 'index.html');

  app.get('/*', async (request, reply) => {
    const path = request.url.split('?', 1)[0] ?? '/';
    if (RESERVED.test(path)) return reply.code(404).send({ error: 'not_found' });

    const file = resolveAssetPath(root, path);
    if (file !== undefined && file !== resolve(root) && (await isFile(file))) {
      const immutable = path.startsWith('/assets/');
      return sendFile(reply, file, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    // A missing file with an extension is a real 404, not a client route.
    if (extname(path) !== '') return reply.code(404).send({ error: 'not_found' });
    return sendFile(reply, index, 'no-cache');
  });
  return true;
}
