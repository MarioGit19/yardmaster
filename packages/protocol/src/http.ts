import { z } from 'zod';
import { SessionHistoryEntry } from './claude-sessions.js';
import { ProjectId, Timestamp } from './domain.js';

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
  /** Started under a file watcher (`pnpm dev`): an edit restarts it and interrupts board sessions. */
  watched: z.boolean().optional(),
  /** Board sessions with a running query. */
  boardSessions: z.number().int().nonnegative().optional(),
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

/** How long the away-mode hook waits for a decision from the board, in seconds (F13). */
export const AWAY_TIMEOUT_MIN_SEC = 10;
export const AWAY_TIMEOUT_MAX_SEC = 300;
export const DEFAULT_AWAY_TIMEOUT_SEC = 120;
export const AwayTimeoutSec = z.number().int().min(AWAY_TIMEOUT_MIN_SEC).max(AWAY_TIMEOUT_MAX_SEC);

/** How long a quiet project stays on the overview, in minutes (`library.idleHideMin`, F26). */
export const IDLE_HIDE_MIN = [15, 30, 60, 120, 480] as const;
export const DEFAULT_IDLE_HIDE_MIN = 30;
export const IdleHideMin = z.literal(IDLE_HIDE_MIN);
export type IdleHideMin = z.infer<typeof IdleHideMin>;

export const LIBRARY_MAX_ROOTS = 8;
export const MAX_PINNED_PROJECTS = 200;

/** A library root as the user typed it: absolute, or under the home directory (`~/Desktop`). */
export const LibraryRootPath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((path) => !path.includes('\0'), 'no NUL bytes')
  .refine((path) => path.startsWith('/') || path === '~' || path.startsWith('~/'), {
    message: 'an absolute path or one starting with ~/',
  });

/** `GET /api/settings` (authenticated): settings the server owns. */
export const BoardSettings = z.object({
  retentionDays: RetentionDays,
  /** Route `PermissionRequest` hooks from terminal sessions to the board (F13). */
  awayMode: z.boolean(),
  awayTimeoutSec: AwayTimeoutSec,
  /** `claude.terminalReply`: reply into a terminal session's terminal (F14), on by default. */
  terminalReply: z.boolean(),
  /** `library.roots`: folders whose top-level directories the picker lists (F25), empty by default. */
  libraryRoots: z.array(LibraryRootPath).max(LIBRARY_MAX_ROOTS),
  /** `library.idleHideMin`: a quiet project leaves the overview after this long (F26). */
  libraryIdleHideMin: IdleHideMin,
  /** Projects that stay on the overview however quiet they are. */
  pinnedProjects: z.array(ProjectId).max(MAX_PINNED_PROJECTS),
});
export type BoardSettings = z.infer<typeof BoardSettings>;

/** `PUT /api/settings` body: any subset of the settings. */
export const BoardSettingsPatch = BoardSettings.partial().strict();
export type BoardSettingsPatch = z.infer<typeof BoardSettingsPatch>;

/** Why a library root couldn't be listed. `permission`: macOS privacy settings block it. */
export const LibraryRootError = z.enum(['permission', 'missing', 'not_directory', 'unreadable']);
export type LibraryRootError = z.infer<typeof LibraryRootError>;

export const LibraryRootStatus = z.object({
  /** As configured, e.g. `~/Desktop`. */
  root: z.string(),
  /** Folders listed from it. */
  count: z.number().int().nonnegative(),
  error: LibraryRootError.nullable(),
  /** What to do about the error, for the user. */
  message: z.string().nullable(),
});
export type LibraryRootStatus = z.infer<typeof LibraryRootStatus>;

export const LibraryEntry = z.object({
  name: z.string().min(1),
  /** Realpath of the folder, inside its root. */
  path: z.string().min(1),
  /** The configured root it was listed from. */
  root: z.string(),
  /** A `.git` exists in it. */
  git: z.boolean(),
  /** The board project for this folder, if the board has seen it. */
  projectId: ProjectId.nullable(),
  /** When that project was last active: recents sort first. */
  lastActiveAt: Timestamp.nullable(),
});
export type LibraryEntry = z.infer<typeof LibraryEntry>;

/** `GET /api/library` (authenticated): the roots' top-level folders, recents first, then by name. */
export const LibraryResponse = z.object({
  roots: z.array(LibraryRootStatus),
  entries: z.array(LibraryEntry),
});
export type LibraryResponse = z.infer<typeof LibraryResponse>;

/** `GET /api/away` (token): polled by `c-board-hook --permission` before it waits on the board. */
export const AwayStatusResponse = z.object({
  away: z.boolean(),
  timeoutSec: AwayTimeoutSec,
});
export type AwayStatusResponse = z.infer<typeof AwayStatusResponse>;

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
