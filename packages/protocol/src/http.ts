import { z } from 'zod';
import { SessionHistoryEntry } from './claude-sessions.js';
import { Timestamp } from './domain.js';

// JSON bodies of the server's HTTP routes, shared by the CLI, the web app and tests.

export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** `GET /api/status` (authenticated): what `c-board doctor` reports about a running board. */
export const ServerStatus = z.object({
  ok: z.literal(true),
  version: z.string(),
  demo: z.boolean(),
  uptimeMs: z.number().nonnegative(),
  /** Connected Cursor / VS Code windows. */
  editors: z.number().int().nonnegative(),
  hooks: z.object({
    /** Hook events received since the server started. */
    received: z.number().int().nonnegative(),
    lastAt: Timestamp.nullable(),
  }),
  /** First-run detection, remembered across restarts: has the board ever seen these? */
  setup: z.object({
    hookSeen: z.boolean(),
    editorSeen: z.boolean(),
  }),
});
export type ServerStatus = z.infer<typeof ServerStatus>;

/** `GET /api/projects/:projectId/sessions` (authenticated): past sessions, newest first (F17). */
export const SessionHistoryResponse = z.object({
  sessions: z.array(SessionHistoryEntry),
});
export type SessionHistoryResponse = z.infer<typeof SessionHistoryResponse>;

/** Activity retention choices, in days (Settings). */
export const RETENTION_DAYS = [1, 7, 30, 90] as const;
export const DEFAULT_RETENTION_DAYS = 7;
export const RetentionDays = z.literal(RETENTION_DAYS);
export type RetentionDays = z.infer<typeof RetentionDays>;

/** `GET /api/settings` (authenticated): settings the server owns. */
export const BoardSettings = z.object({
  retentionDays: RetentionDays,
});
export type BoardSettings = z.infer<typeof BoardSettings>;

/** `PUT /api/settings` body: any subset of the settings. */
export const BoardSettingsPatch = BoardSettings.partial().strict();
export type BoardSettingsPatch = z.infer<typeof BoardSettingsPatch>;

/** Observer hook events from the installer, by state. */
export const HookEventStatus = z.object({
  installed: z.array(z.string()),
  missing: z.array(z.string()),
  /** Ours, but with a different command or shape than an install would write. */
  outdated: z.array(z.string()),
});
export type HookEventStatus = z.infer<typeof HookEventStatus>;

/** `GET /api/hooks` (authenticated): the c-board hooks in Claude's settings.json. */
export const HooksStatusResponse = z.object({
  /** The settings file, with the home directory shortened to `~`. */
  path: z.string(),
  /** Null when the file can't be read or parsed; `error` says why. */
  status: HookEventStatus.nullable(),
  error: z.string().nullable(),
});
export type HooksStatusResponse = z.infer<typeof HooksStatusResponse>;

/** `POST /api/hooks/plan` (authenticated): what an install would change, for the confirm dialog. */
export const HooksPlanResponse = z.object({
  path: z.string(),
  changed: z.boolean(),
  /** Unified diff of settings.json; empty when nothing would change. */
  diff: z.string(),
  /** Identifies the file content the plan was made from; the install must send it back. */
  fingerprint: z.string(),
});
export type HooksPlanResponse = z.infer<typeof HooksPlanResponse>;

/** `POST /api/hooks/install` body. Refused with 409 when the file changed since the plan. */
export const HooksInstallRequest = z.object({
  fingerprint: z.string().min(1).max(128),
});
export type HooksInstallRequest = z.infer<typeof HooksInstallRequest>;

export const HooksInstallResponse = z.object({
  ok: z.literal(true),
  changed: z.boolean(),
  /** The backup written before the edit, shortened like `path`. */
  backup: z.string().nullable(),
  status: HookEventStatus,
});
export type HooksInstallResponse = z.infer<typeof HooksInstallResponse>;

/** `POST /api/token/rotate`: also sets a fresh session cookie for the calling browser. */
export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

/** Error bodies of the settings routes. */
export const ApiError = z.object({
  error: z.string(),
  message: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
