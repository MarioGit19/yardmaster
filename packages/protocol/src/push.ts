import { z } from 'zod';
import { ApprovalId, ProjectId, Timestamp } from './domain.js';

// Web Push notifications (12.6e3): the events, the subscriptions and what the service worker gets.

/** The events a push can be about, each a toggle in Settings → Notifications. */
export const NOTIFY_EVENTS = [
  'needs_you',
  'claude_finished',
  'command_finished',
  'crashed',
  'background',
] as const;
export const NotifyEvent = z.enum(NOTIFY_EVENTS);
export type NotifyEvent = z.infer<typeof NotifyEvent>;

/** On until turned off: everything but background tasks and subagents. */
export const DEFAULT_NOTIFY_EVENTS: readonly NotifyEvent[] = [
  'needs_you',
  'claude_finished',
  'command_finished',
  'crashed',
];

/** A Claude turn or a command must run at least this long before its end is worth a push. */
export const NOTIFY_LONG_RUN_MS = 30_000;
/** At most one push per project in this window; later events update it (same `tag`). */
export const NOTIFY_COALESCE_MS = 20_000;
export const MAX_PUSH_SUBSCRIPTIONS = 20;

/** `PushSubscription.toJSON()` from the browser, sent to `POST /api/push/subscriptions`. */
export const PushSubscriptionInput = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_=-]+$/),
    auth: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_=-]+$/),
  }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

export const PushSubscribeResponse = z.object({ id: z.string().min(1).max(64) });
export type PushSubscribeResponse = z.infer<typeof PushSubscribeResponse>;

/** A subscribed browser, as Settings lists it. Never carries the endpoint or keys. */
export const PushDevice = z.object({
  id: z.string().min(1).max(64),
  /** From the user agent, such as "iPhone · Safari". */
  name: z.string().max(80),
  createdAt: Timestamp,
  lastSentAt: Timestamp.nullable(),
});
export type PushDevice = z.infer<typeof PushDevice>;

/** `GET /api/push`: the VAPID public key the browser subscribes with, and the subscriptions. */
export const PushInfoResponse = z.object({
  publicKey: z.string().min(1),
  devices: z.array(PushDevice),
});
export type PushInfoResponse = z.infer<typeof PushInfoResponse>;

/** `POST /api/push/test`. */
export const PushTestRequest = z.object({ id: z.string().min(1).max(64) }).strict();
export type PushTestRequest = z.infer<typeof PushTestRequest>;

/** `POST /api/approvals/:id/decision`: a notification's Allow / Deny action. */
export const ApprovalDecisionRequest = z.object({ decision: z.enum(['allow', 'deny']) }).strict();
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

/** What the service worker receives. `request` names what a notification asks about. */
export const PushPayload = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('show'),
    kind: z.union([NotifyEvent, z.literal('test')]),
    title: z.string().max(200),
    body: z.string().max(400),
    /** One notification per project: a later one replaces it. */
    tag: z.string().max(300),
    /** The board route to open, such as `/#/p/<id>/s/<id>`. */
    url: z.string().max(2048),
    /** An approval or a session waiting; closed once answered elsewhere. */
    request: z.string().max(300).nullable(),
    /** Allow / Deny actions decide this approval (away mode only). */
    approvalId: ApprovalId.nullable(),
    ts: Timestamp,
  }),
  z.object({
    type: z.literal('close'),
    tag: z.string().max(300),
    request: z.string().max(300),
  }),
]);
export type PushPayload = z.infer<typeof PushPayload>;

/** `GET /api/push/outbox`, demo only: what the simulated push service was handed. */
export const PushOutboxResponse = z.object({
  sent: z.array(z.object({ subscriptionId: z.string(), payload: PushPayload })),
});
export type PushOutboxResponse = z.infer<typeof PushOutboxResponse>;

export const MAX_MUTED_PROJECTS = 200;
export const NotifyMutedProjects = z.array(ProjectId).max(MAX_MUTED_PROJECTS);
