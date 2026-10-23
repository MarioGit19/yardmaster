import { createHash, randomBytes } from 'node:crypto';
import {
  PAIRING_CODE_TTL_MS,
  type PairedDevice,
  type PairedDevicesResponse,
  PairingRequest,
  type PairingResponse,
  RemoteHost,
} from '@c-board/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tokensEqual } from './token.js';

export const REMOTE_HOSTS_KEY = 'remote.allowedHosts';
export const DEVICES_KEY = 'remote.devices';
export const DEVICE_COOKIE = 'cboard_device';
/** A paired phone stays signed in this long without pairing again, unless revoked. */
export const DEVICE_COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60;
export const MAX_DEVICES = 20;
/** `lastSeenAt` is written at most this often per device. */
const SEEN_WRITE_MS = 5 * 60 * 1000;

const StoredDevice = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  name: z.string().max(80),
  /** sha256 of the cookie secret, base64url. The secret itself is never stored. */
  hash: z.string().min(1).max(128),
  pairedAt: z.number().int(),
  lastSeenAt: z.number().int(),
});
type StoredDevice = z.infer<typeof StoredDevice>;

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

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('base64url');

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

interface TrackedSocket {
  close(code?: number, reason?: string): void;
  once(event: 'close', listener: () => void): unknown;
}

export interface RemoteDevicesOptions {
  /** Persists the device list (the `settings` table). */
  load(): unknown;
  save(devices: unknown): void;
  now?: () => number;
}

export type RedeemResult =
  | { ok: true; device: PairedDevice; cookie: string }
  | { ok: false; error: 'invalid' | 'expired' };

/**
 * Pairing (PRD §8 item 12): one live one-time code at a time (5 minutes, single use) and the
 * paired devices, each with its own cookie secret, so one can be revoked without the others.
 */
export class RemoteDevices {
  private readonly options: RemoteDevicesOptions;
  private readonly now: () => number;
  private devices: StoredDevice[];
  private code: { hash: string; expiresAt: number } | null = null;
  private readonly revokeListeners = new Set<(id: string) => void>();

  constructor(options: RemoteDevicesOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    const stored = options.load();
    this.devices = Array.isArray(stored)
      ? stored.flatMap((d) => {
          const parsed = StoredDevice.safeParse(d);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  }

  /** A fresh code; any earlier one stops working. */
  createCode(): { code: string; expiresAt: number } {
    const code = randomBytes(18).toString('base64url');
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.code = { hash: hashSecret(code), expiresAt };
    return { code, expiresAt };
  }

  /** Spends a code (right or expired) and pairs a new device. */
  redeem(code: string, userAgent: string | undefined): RedeemResult {
    const live = this.code;
    if (!live || !tokensEqual(hashSecret(code), live.hash)) return { ok: false, error: 'invalid' };
    this.code = null;
    const now = this.now();
    if (now > live.expiresAt) return { ok: false, error: 'expired' };

    const id = randomBytes(12).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const device: StoredDevice = {
      id,
      name: deviceName(userAgent),
      hash: hashSecret(secret),
      pairedAt: now,
      lastSeenAt: now,
    };
    // Oldest first out once the list is full.
    this.devices = [...this.devices, device].slice(-MAX_DEVICES);
    this.persist();
    return { ok: true, device: this.view(device, id), cookie: `${id}.${secret}` };
  }

  /** The device a cookie value belongs to, or null. Marks it seen. */
  verify(cookie: string | undefined): string | null {
    if (!cookie) return null;
    const dot = cookie.indexOf('.');
    if (dot <= 0) return null;
    const id = cookie.slice(0, dot);
    const device = this.devices.find((d) => d.id === id);
    if (!device || !tokensEqual(hashSecret(cookie.slice(dot + 1)), device.hash)) return null;
    const now = this.now();
    if (now - device.lastSeenAt >= SEEN_WRITE_MS) {
      device.lastSeenAt = now;
      this.persist();
    }
    return id;
  }

  list(currentId: string | null = null): PairedDevice[] {
    return [...this.devices]
      .sort((a, b) => b.pairedAt - a.pairedAt)
      .map((d) => this.view(d, currentId));
  }

  revoke(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.persist();
    for (const listener of this.revokeListeners) listener(id);
    return true;
  }

  /** Closes a device's sockets when it is revoked. */
  track(id: string, socket: TrackedSocket): void {
    const listener = (revoked: string) => {
      if (revoked === id) socket.close(4401, 'revoked');
    };
    this.revokeListeners.add(listener);
    socket.once('close', () => this.revokeListeners.delete(listener));
  }

  private view(device: StoredDevice, currentId: string | null): PairedDevice {
    const { hash: _hash, ...rest } = device;
    return { ...rest, current: device.id === currentId };
  }

  private persist(): void {
    this.options.save(this.devices);
  }
}

const DeviceParams = z.object({ id: z.string().min(1).max(64) });

/**
 * Pairing and paired devices (F27), under `/api` so the auth guard covers them. Only the board
 * on this machine makes pairing codes: a paired phone can't pair more devices.
 */
export function registerRemoteRoutes(
  app: FastifyInstance,
  options: { devices: RemoteDevices; hosts: () => readonly string[] },
): void {
  const { devices } = options;

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
    const { code, expiresAt } = devices.createCode();
    return {
      url: `https://${host}/pair?c=${encodeURIComponent(code)}`,
      host,
      expiresAt,
    } satisfies PairingResponse;
  });

  app.get('/api/remote/devices', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return { devices: devices.list(request.remoteDevice()) } satisfies PairedDevicesResponse;
  });

  app.delete('/api/remote/devices/:id', async (request, reply) => {
    const params = DeviceParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'bad_request' });
    if (!devices.revoke(params.data.id)) return reply.code(404).send({ error: 'unknown_device' });
    app.log.info('revoked a paired device');
    return { ok: true };
  });
}
