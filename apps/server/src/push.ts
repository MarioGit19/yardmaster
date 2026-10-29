import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ApprovalDecision,
  ApprovalDecisionRequest,
  MAX_PUSH_SUBSCRIPTIONS,
  type PushDevice,
  type PushInfoResponse,
  type PushOutboxResponse,
  type PushPayload,
  type PushSubscribeResponse,
  PushSubscriptionInput,
  PushTestRequest,
} from '@yardmaster/protocol';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { z } from 'zod';
import type { ActionResult } from './actions.js';
import { deviceName } from './remote.js';

export const SUBSCRIPTIONS_KEY = 'push.subscriptions';
export const VAPID_FILE = 'vapid.json';
/** The VAPID `sub` claim: a contact for the push services, never a real person's address. */
const VAPID_SUBJECT = 'mailto:yardmaster@users.noreply.github.com';
/** A push the device can't take within this long is dropped by the push service. */
const PUSH_TTL_SEC = 60 * 60;
const OUTBOX_MAX = 200;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const VapidFile = z.object({
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
  privateKey: z.string().regex(/^[A-Za-z0-9_-]{40,50}$/),
});

/**
 * The board's VAPID keys from `<home>/vapid.json` (0600), generated on first use. They identify
 * this board to the push services; they never leave the machine but for the public half.
 */
export async function loadVapidKeys(home: string): Promise<VapidKeys> {
  const path = join(home, VAPID_FILE);
  try {
    const parsed = VapidFile.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (parsed.success) return parsed.data;
  } catch {
    // Missing or unreadable: make new ones. Old subscriptions stop working and are cleaned up.
  }
  const keys = webpush.generateVAPIDKeys();
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return keys;
}

/** Throwaway keys for the demo board, which may run on a real home: it never writes one. */
export function memoryVapidKeys(): VapidKeys {
  return webpush.generateVAPIDKeys();
}

/** Push services browsers subscribe with. Anything else is refused: the server posts to it. */
const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
];
const PUSH_SERVICE_SUFFIXES = [
  '.push.services.mozilla.com',
  '.push.apple.com',
  '.notify.windows.com',
];

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return (
    PUSH_SERVICE_HOSTS.includes(host) || PUSH_SERVICE_SUFFIXES.some((end) => host.endsWith(end))
  );
}

const StoredSubscription = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  /** The browser session it belongs to, or null when added with the token (tools, tests). */
  deviceId: z.string().max(64).nullable(),
  name: z.string().max(80),
  endpoint: z.string().max(2048),
  p256dh: z.string().max(256),
  auth: z.string().max(64),
  createdAt: z.number().int(),
  lastSentAt: z.number().int().nullable(),
});
export type StoredSubscription = z.infer<typeof StoredSubscription>;

export interface PushSubscriptionsOptions {
  load(): unknown;
  save(subscriptions: unknown): void;
  now?: () => number;
}

/** Push subscriptions, one per browser, kept in the settings table. */
export class PushSubscriptions {
  private items: StoredSubscription[];
  private readonly now: () => number;

  constructor(private readonly options: PushSubscriptionsOptions) {
    this.now = options.now ?? Date.now;
    const stored = options.load();
    this.items = Array.isArray(stored)
      ? stored.flatMap((s) => {
          const parsed = StoredSubscription.safeParse(s);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  }

  list(): readonly StoredSubscription[] {
    return this.items;
  }

  get(id: string): StoredSubscription | undefined {
    return this.items.find((s) => s.id === id);
  }

  /** Adds a subscription; the same endpoint again keeps its id. Oldest out once full. */
  add(
    input: PushSubscriptionInput,
    owner: { deviceId: string | null; userAgent: string | undefined },
  ): string {
    const existing = this.items.find((s) => s.endpoint === input.endpoint);
    const id = existing?.id ?? randomBytes(12).toString('base64url');
    const item: StoredSubscription = {
      id,
      deviceId: owner.deviceId,
      name: deviceName(owner.userAgent),
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      createdAt: existing?.createdAt ?? this.now(),
      lastSentAt: existing?.lastSentAt ?? null,
    };
    this.items = [...this.items.filter((s) => s.id !== id), item].slice(-MAX_PUSH_SUBSCRIPTIONS);
    this.persist();
    return id;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((s) => s.id !== id);
    if (this.items.length === before) return false;
    this.persist();
    return true;
  }

  /** Moves a session's subscriptions to the session that replaces it. */
  moveDevice(from: string, to: string): void {
    let moved = false;
    for (const item of this.items) {
      if (item.deviceId !== from) continue;
      item.deviceId = to;
      moved = true;
    }
    if (moved) this.persist();
  }

  /** Keeps only subscriptions of live sessions: a signed-out browser gets no notifications. */
  retainDevices(live: (deviceId: string) => boolean): number {
    const before = this.items.length;
    this.items = this.items.filter((s) => s.deviceId !== null && live(s.deviceId));
    const removed = before - this.items.length;
    if (removed > 0) this.persist();
    return removed;
  }

  /** Drops every subscription of a session that ended. */
  removeDevice(deviceId: string): number {
    const before = this.items.length;
    this.items = this.items.filter((s) => s.deviceId !== deviceId);
    const removed = before - this.items.length;
    if (removed > 0) this.persist();
    return removed;
  }

  markSent(id: string, ts = this.now()): void {
    const item = this.items.find((s) => s.id === id);
    if (!item) return;
    item.lastSentAt = ts;
    this.persist();
  }

  devices(): PushDevice[] {
    return [...this.items]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ id, name, createdAt, lastSentAt }) => ({ id, name, createdAt, lastSentAt }));
  }

  private persist(): void {
    this.options.save(this.items);
  }
}

export type SendResult = { ok: true } | { ok: false; gone: boolean; status: number | null };

export interface SendOptions {
  urgency: 'high' | 'normal' | 'low';
}

/** Hands one payload to a subscription's push service. */
export type PushSender = (
  subscription: StoredSubscription,
  payload: PushPayload,
  options: SendOptions,
) => Promise<SendResult>;

/**
 * The real sender: `web-push` encrypts the payload for the browser (RFC 8291), so the push
 * service only relays ciphertext. 404 and 410 mean the subscription is gone.
 */
export function webPushSender(keys: () => Promise<VapidKeys>): PushSender {
  return async (subscription, payload, options) => {
    const { publicKey, privateKey } = await keys();
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(payload),
        {
          vapidDetails: { subject: VAPID_SUBJECT, publicKey, privateKey },
          TTL: PUSH_TTL_SEC,
          urgency: options.urgency,
          timeout: 10_000,
        },
      );
      return { ok: true };
    } catch (err) {
      const status = err instanceof webpush.WebPushError ? err.statusCode : null;
      return { ok: false, gone: status === 404 || status === 410, status };
    }
  };
}

/** The demo's push service: keeps what it was handed, for the e2e to read. Sends nothing. */
export class DemoOutbox {
  readonly sent: PushOutboxResponse['sent'] = [];

  readonly sender: PushSender = async (subscription, payload) => {
    this.sent.push({ subscriptionId: subscription.id, payload });
    if (this.sent.length > OUTBOX_MAX) this.sent.splice(0, this.sent.length - OUTBOX_MAX);
    return { ok: true };
  };
}

const IdParams = z.object({ id: z.string().min(1).max(64) });
const ApprovalParams = z.object({ id: z.string().min(1).max(256) });

export interface PushRoutesOptions {
  subscriptions: PushSubscriptions;
  keys: () => Promise<VapidKeys>;
  /** Sends the test notification to one subscription. */
  test: (subscription: StoredSubscription) => Promise<SendResult>;
  /** The same path as the Attention Center's buttons. */
  decideApproval: (decision: ApprovalDecision) => ActionResult | Promise<ActionResult>;
  /** Demo mode: endpoints aren't checked, and the outbox and the drill are served. */
  demo: { outbox: DemoOutbox; drill: () => void } | null;
  logger: FastifyBaseLogger;
}

/** Push subscriptions, the test push and notification actions, all behind the auth guard. */
export function registerPushRoutes(app: FastifyInstance, options: PushRoutesOptions): void {
  const { subscriptions } = options;

  app.get('/api/push', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const { publicKey } = await options.keys();
    return { publicKey, devices: subscriptions.devices() } satisfies PushInfoResponse;
  });

  app.post('/api/push/subscriptions', async (request, reply) => {
    const body = PushSubscriptionInput.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    if (!options.demo && !isPushServiceEndpoint(body.data.endpoint)) {
      options.logger.warn('refused a push subscription for an unknown push service');
      return reply.code(422).send({ error: 'unknown_push_service' });
    }
    const id = subscriptions.add(body.data, {
      deviceId: request.browserSession(),
      userAgent: request.headers['user-agent'],
    });
    return { id } satisfies PushSubscribeResponse;
  });

  app.delete('/api/push/subscriptions/:id', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'bad_request' });
    if (!subscriptions.remove(params.data.id)) {
      return reply.code(404).send({ error: 'unknown_subscription' });
    }
    return { ok: true };
  });

  app.post('/api/push/test', async (request, reply) => {
    const body = PushTestRequest.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const subscription = subscriptions.get(body.data.id);
    if (!subscription) return reply.code(404).send({ error: 'unknown_subscription' });
    const result = await options.test(subscription);
    if (result.ok) return { ok: true };
    if (result.gone) {
      subscriptions.remove(subscription.id);
      return reply.code(410).send({
        error: 'subscription_gone',
        message: 'This device stopped taking notifications. Turn them on again.',
      });
    }
    return reply.code(502).send({
      error: 'push_failed',
      message: 'The push service did not take the notification. Try again in a moment.',
    });
  });

  app.post('/api/approvals/:id/decision', async (request, reply) => {
    const params = ApprovalParams.safeParse(request.params);
    const body = ApprovalDecisionRequest.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'bad_request' });
    const result = await options.decideApproval({
      approvalId: params.data.id,
      decision: body.data.decision,
    });
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return { ok: true };
  });

  const { demo } = options;
  if (demo) {
    app.get('/api/push/outbox', async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      return { sent: demo.outbox.sent } satisfies PushOutboxResponse;
    });
    app.post('/api/push/drill', async () => {
      demo.drill();
      return { ok: true };
    });
  }
}
