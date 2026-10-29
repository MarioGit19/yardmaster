import {
  type PairedDevice,
  type PairedDevicesResponse,
  PairingRequest,
  type PairingResponse,
  RemoteHost,
} from '@yardmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BrowserSessions } from './sessions.js';

export const REMOTE_HOSTS_KEY = 'remote.allowedHosts';
/** Paired devices before per-browser sessions (cookie based): dropped at start, phones pair again. */
export const LEGACY_DEVICES_KEY = 'remote.devices';

/** The stored `remote.allowedHosts`, keeping only valid, distinct Tailscale names. */
export function remoteHosts(settings: Record<string, unknown>): string[] {
  const value = settings[REMOTE_HOSTS_KEY];
  if (!Array.isArray(value)) return [];
  const hosts = value.flatMap((v) => {
    const parsed = RemoteHost.safeParse(v);
    return parsed.success ? [parsed.data] : [];
  });
  return [...new Set(hosts)];
}

/** A short, non-identifying label from a user agent: the device kind and the browser. */
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const kind = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? /Mobile/.test(ua)
          ? 'Android phone'
          : 'Android tablet'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device';
  const browser = /EdgiOS|EdgA|Edg\//.test(ua)
    ? 'Edge'
    : /FxiOS|Firefox\//.test(ua)
      ? 'Firefox'
      : /CriOS|Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  return browser ? `${kind} · ${browser}` : kind;
}

const DeviceParams = z.object({ id: z.string().min(1).max(64) });

/**
 * Pairing and paired devices (F27), under `/api` so the auth guard covers them. Only the board
 * on this machine makes pairing codes: a paired phone can't pair more devices.
 */
export function registerRemoteRoutes(
  app: FastifyInstance,
  options: { sessions: BrowserSessions; hosts: () => readonly string[] },
): void {
  const { sessions } = options;

  app.post('/api/remote/pair', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (request.isRemote()) return reply.code(403).send({ error: 'local_only' });
    const body = PairingRequest.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const hosts = options.hosts();
    const host = body.data.host ?? hosts[0];
    if (host === undefined || !hosts.includes(host)) {
      return reply.code(409).send({
        error: 'no_remote_host',
        message: 'Add your Mac’s Tailscale name under Allowed hosts first.',
      });
    }
    const { code, expiresAt } = sessions.createPairingCode();
    return {
      url: `https://${host}/pair?c=${encodeURIComponent(code)}`,
      host,
      expiresAt,
    } satisfies PairingResponse;
  });

  app.get('/api/remote/devices', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const devices = sessions.list(request.browserSession(), 'remote').map(
      ({ id, name, createdAt, lastSeenAt, current }): PairedDevice => ({
        id,
        name,
        pairedAt: createdAt,
        lastSeenAt,
        current,
      }),
    );
    return { devices } satisfies PairedDevicesResponse;
  });

  app.delete('/api/remote/devices/:id', async (request, reply) => {
    const params = DeviceParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'bad_request' });
    const remote = sessions.list(null, 'remote').some((s) => s.id === params.data.id);
    if (!remote || !sessions.revoke(params.data.id)) {
      return reply.code(404).send({ error: 'unknown_device' });
    }
    app.log.info('revoked a paired device');
    return { ok: true };
  });
}
