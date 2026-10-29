import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  applyPlan,
  claudeSettingsPath,
  hookCommand,
  hookStatus,
  InvalidSettingsError,
  type Plan,
  permissionHookCommand,
  planInstall,
  readSettings,
  unifiedDiff,
} from '@yardmaster/hook';
import {
  AwayTimeoutSec,
  type BoardSettings,
  BoardSettingsPatch,
  DEFAULT_AWAY_TIMEOUT_SEC,
  DEFAULT_IDLE_HIDE_MIN,
  DEFAULT_NOTIFY_EVENTS,
  DEFAULT_RETENTION_DAYS,
  EditorCliPath,
  HooksInstallRequest,
  type HooksInstallResponse,
  type HooksPlanResponse,
  type HooksStatusResponse,
  IdleHideMin,
  LIBRARY_MAX_ROOTS,
  LibraryRootPath,
  MAX_MUTED_PROJECTS,
  MAX_PINNED_PROJECTS,
  NotifyEvent,
  ProjectId,
  RetentionDays,
} from '@yardmaster/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { tildify } from './doctor.js';
import type { Persistence } from './persistence.js';
import { REMOTE_HOSTS_KEY, remoteHosts } from './remote.js';
import { LEGACY_TERMINAL_REPLY_KEY, TERMINAL_REPLY_KEY } from './terminal-reply.js';
import { generateToken, writeToken } from './token.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_KEY = 'retentionDays';
export const AWAY_MODE_KEY = 'awayMode';
export const AWAY_TIMEOUT_KEY = 'awayTimeoutSec';
export const HOOK_SEEN_KEY = 'setup.hookSeen';
export const EDITOR_SEEN_KEY = 'setup.editorSeen';
export const LIBRARY_ROOTS_KEY = 'library.roots';
export const IDLE_HIDE_KEY = 'library.idleHideMin';
export const PINNED_KEY = 'library.pinned';
export const EDITOR_CLI_KEY = 'editor.cli';
export const NOTIFY_EVENTS_KEY = 'notify.events';
export const NOTIFY_HIDE_DETAILS_KEY = 'notify.hideDetails';
export const NOTIFY_MUTED_KEY = 'notify.mutedProjects';

/** Claude's settings.json as the hooks routes see it. Demo mode swaps in an in-memory one. */
export interface HookSettingsFile {
  /** Shown to the user. */
  displayPath: string;
  /** The handler command an install writes. */
  command: string;
  /** The away-mode handler's command, for refreshing an installed one. */
  permissionCommand: string;
  read(): Promise<string | undefined>;
  /** Writes a plan; returns the displayed backup path, if one was made. */
  apply(plan: Plan): Promise<string | undefined>;
}

export function diskHookSettings(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): HookSettingsFile {
  const path = claudeSettingsPath(env, home);
  return {
    displayPath: tildify(path, home),
    command: hookCommand(),
    permissionCommand: permissionHookCommand(),
    read: () => readSettings(path),
    apply: async (plan) => {
      const backup = await applyPlan(path, plan);
      return backup === undefined ? undefined : tildify(backup, home);
    },
  };
}

/** A synthetic settings.json for the demo board, so it never reads or writes the real one. */
export function memoryHookSettings(initial?: string): HookSettingsFile {
  let text = initial;
  return {
    displayPath: '~/.claude/settings.json',
    command: '/opt/yardmaster/bin/yardmaster-hook',
    permissionCommand:
      '/opt/yardmaster/bin/node /opt/yardmaster/bin/yardmaster-hook-permission.mjs',
    read: async () => text,
    apply: async (plan) => {
      if (!plan.changed) return undefined;
      if (text !== plan.before)
        throw new InvalidSettingsError('changed while Yardmaster was editing it');
      text = plan.after;
      return undefined;
    },
  };
}

/** Identifies the content a plan was made from; a missing file differs from an empty one. */
export function fingerprint(raw: string | undefined): string {
  return createHash('sha256')
    .update(raw === undefined ? '\0missing' : `\0file${raw}`)
    .digest('base64url');
}

export function retentionDays(value: unknown): RetentionDays {
  const parsed = RetentionDays.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_RETENTION_DAYS;
}

/** The stored away-mode setting; off unless explicitly turned on. */
export function awaySettings(settings: Record<string, unknown>): {
  awayMode: boolean;
  awayTimeoutSec: number;
} {
  const timeout = AwayTimeoutSec.safeParse(settings[AWAY_TIMEOUT_KEY]);
  return {
    awayMode: settings[AWAY_MODE_KEY] === true,
    awayTimeoutSec: timeout.success ? timeout.data : DEFAULT_AWAY_TIMEOUT_SEC,
  };
}

/** `claude.terminalReply`: on unless turned off, here or under the old experimental key. */
export function terminalReplyEnabled(settings: Record<string, unknown>): boolean {
  const stored = settings[TERMINAL_REPLY_KEY];
  if (typeof stored === 'boolean') return stored;
  return settings[LEGACY_TERMINAL_REPLY_KEY] !== false;
}

/** Moves a stored `experimental.terminalReply: false` to its new key (the old one stays). */
export function migrateTerminalReply(
  settings: Record<string, unknown>,
  save: (key: string, value: unknown) => void,
): void {
  if (settings[TERMINAL_REPLY_KEY] !== undefined) return;
  if (settings[LEGACY_TERMINAL_REPLY_KEY] !== false) return;
  settings[TERMINAL_REPLY_KEY] = false;
  save(TERMINAL_REPLY_KEY, false);
}

/** A stored list, keeping only the items that still validate (and dropping duplicates). */
function storedList(value: unknown, item: { safeParse(v: unknown): { success: boolean } }) {
  if (!Array.isArray(value)) return [];
  const items = value.filter(
    (v): v is string => typeof v === 'string' && item.safeParse(v).success,
  );
  return [...new Set(items)];
}

/** The stored library settings (12.1): no roots, a 30-minute idle window and no pins by default. */
export function librarySettings(settings: Record<string, unknown>): {
  libraryRoots: string[];
  libraryIdleHideMin: IdleHideMin;
  pinnedProjects: string[];
} {
  const idle = IdleHideMin.safeParse(settings[IDLE_HIDE_KEY]);
  return {
    libraryRoots: storedList(settings[LIBRARY_ROOTS_KEY], LibraryRootPath).slice(
      0,
      LIBRARY_MAX_ROOTS,
    ),
    libraryIdleHideMin: idle.success ? idle.data : DEFAULT_IDLE_HIDE_MIN,
    pinnedProjects: storedList(settings[PINNED_KEY], ProjectId).slice(0, MAX_PINNED_PROJECTS),
  };
}

/** `editor.cli`: the stored editor CLI path, or null to look for `cursor`, then `code`. */
export function editorCliSetting(settings: Record<string, unknown>): string | null {
  const parsed = EditorCliPath.safeParse(settings[EDITOR_CLI_KEY]);
  return parsed.success ? parsed.data : null;
}

/** The stored push notification settings (12.6e3): the default events, details shown, none muted. */
export function notifySettings(settings: Record<string, unknown>): {
  notifyEvents: NotifyEvent[];
  notifyHideDetails: boolean;
  notifyMutedProjects: string[];
} {
  const events = settings[NOTIFY_EVENTS_KEY];
  return {
    notifyEvents: Array.isArray(events)
      ? (storedList(events, NotifyEvent) as NotifyEvent[])
      : [...DEFAULT_NOTIFY_EVENTS],
    notifyHideDetails: settings[NOTIFY_HIDE_DETAILS_KEY] === true,
    notifyMutedProjects: storedList(settings[NOTIFY_MUTED_KEY], ProjectId).slice(
      0,
      MAX_MUTED_PROJECTS,
    ),
  };
}

export function retentionMs(days: RetentionDays): number {
  return days * DAY_MS;
}

export interface SettingsRoutesOptions {
  persistence: Persistence;
  /** Settings loaded at boot; kept in sync with writes. */
  settings: Record<string, unknown>;
  hookSettings: HookSettingsFile;
  /**
   * Rotates the token and ends every session, or null when the board can't (demo mode). Returns
   * a fresh session secret for the calling browser, if it had one.
   */
  rotateToken: ((caller: RotateCaller) => Promise<{ session?: string }>) | null;
}

/** Who asked for a rotation: their browser session (if any) is replaced, not ended. */
export interface RotateCaller {
  session: string | null;
  remote: boolean;
  userAgent: string | undefined;
}

function settingsError(reply: FastifyReply, err: unknown) {
  if (err instanceof InvalidSettingsError) {
    return reply.code(422).send({ error: 'invalid_settings', message: err.message });
  }
  throw err;
}

/**
 * Settings (F11, 8.5): server-owned preferences, the hooks status and installer, and token
 * rotation. All under `/api`, so the auth guard covers them.
 */
export function registerSettingsRoutes(app: FastifyInstance, options: SettingsRoutesOptions): void {
  const { persistence, settings, hookSettings } = options;
  const current = (): BoardSettings => ({
    retentionDays: retentionDays(settings[RETENTION_KEY]),
    ...awaySettings(settings),
    terminalReply: terminalReplyEnabled(settings),
    ...librarySettings(settings),
    editorCli: editorCliSetting(settings),
    remoteAllowedHosts: remoteHosts(settings),
    ...notifySettings(settings),
  });
  const save = (key: string, value: unknown) => {
    persistence.setSetting(key, value);
    settings[key] = value;
  };

  app.get('/api/settings', async () => current());

  app.put('/api/settings', async (request, reply) => {
    const patch = BoardSettingsPatch.safeParse(request.body);
    if (!patch.success) return reply.code(400).send({ error: 'bad_request' });
    if (patch.data.retentionDays !== undefined) {
      save(RETENTION_KEY, patch.data.retentionDays);
      persistence.setRetention(retentionMs(patch.data.retentionDays));
    }
    if (patch.data.awayMode !== undefined) {
      save(AWAY_MODE_KEY, patch.data.awayMode);
      app.log.info({ away: patch.data.awayMode }, 'away mode changed');
    }
    if (patch.data.awayTimeoutSec !== undefined) save(AWAY_TIMEOUT_KEY, patch.data.awayTimeoutSec);
    if (patch.data.terminalReply !== undefined) save(TERMINAL_REPLY_KEY, patch.data.terminalReply);
    if (patch.data.libraryRoots !== undefined) {
      save(LIBRARY_ROOTS_KEY, [...new Set(patch.data.libraryRoots)]);
    }
    if (patch.data.libraryIdleHideMin !== undefined) {
      save(IDLE_HIDE_KEY, patch.data.libraryIdleHideMin);
    }
    if (patch.data.pinnedProjects !== undefined) {
      save(PINNED_KEY, [...new Set(patch.data.pinnedProjects)]);
    }
    if (patch.data.editorCli !== undefined) save(EDITOR_CLI_KEY, patch.data.editorCli);
    if (patch.data.remoteAllowedHosts !== undefined) {
      save(REMOTE_HOSTS_KEY, [...new Set(patch.data.remoteAllowedHosts)]);
      app.log.info({ hosts: patch.data.remoteAllowedHosts.length }, 'remote hosts changed');
    }
    if (patch.data.notifyEvents !== undefined) {
      save(NOTIFY_EVENTS_KEY, [...new Set(patch.data.notifyEvents)]);
    }
    if (patch.data.notifyHideDetails !== undefined) {
      save(NOTIFY_HIDE_DETAILS_KEY, patch.data.notifyHideDetails);
    }
    if (patch.data.notifyMutedProjects !== undefined) {
      save(NOTIFY_MUTED_KEY, [...new Set(patch.data.notifyMutedProjects)]);
    }
    return current();
  });

  app.get('/api/hooks', async (): Promise<HooksStatusResponse> => {
    const path = hookSettings.displayPath;
    try {
      const raw = await hookSettings.read();
      return { path, status: hookStatus(raw, hookSettings.command), error: null };
    } catch (err) {
      const message = err instanceof InvalidSettingsError ? err.message : 'could not be read';
      if (!(err instanceof InvalidSettingsError)) app.log.warn({ err }, 'reading hook settings');
      return { path, status: null, error: message };
    }
  });

  app.post('/api/hooks/plan', async (_request, reply) => {
    try {
      const raw = await hookSettings.read();
      const plan = planInstall(raw, hookSettings.command, {
        permissionCommand: hookSettings.permissionCommand,
      });
      const path = hookSettings.displayPath;
      return {
        path,
        changed: plan.changed,
        diff: plan.changed ? unifiedDiff(raw ?? '', plan.after, path, path) : '',
        fingerprint: fingerprint(raw),
      } satisfies HooksPlanResponse;
    } catch (err) {
      return settingsError(reply, err);
    }
  });

  app.post('/api/hooks/install', async (request, reply) => {
    const body = HooksInstallRequest.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    try {
      const raw = await hookSettings.read();
      // Only ever write exactly what the user confirmed.
      if (fingerprint(raw) !== body.data.fingerprint) {
        return reply.code(409).send({ error: 'changed' });
      }
      const plan = planInstall(raw, hookSettings.command, {
        permissionCommand: hookSettings.permissionCommand,
      });
      const backup = await hookSettings.apply(plan);
      app.log.info({ changed: plan.changed }, 'installed hooks from the board');
      return {
        ok: true,
        changed: plan.changed,
        backup: backup ?? null,
        status: hookStatus(plan.after, hookSettings.command),
      } satisfies HooksInstallResponse;
    } catch (err) {
      return settingsError(reply, err);
    }
  });

  app.post('/api/token/rotate', async (request, reply) => {
    if (!options.rotateToken) return reply.code(409).send({ error: 'demo' });
    const { session } = await options.rotateToken({
      session: request.browserSession(),
      remote: request.isRemote(),
      userAgent: request.headers['user-agent'],
    });
    app.log.info('rotated the install token from the board');
    // This browser stays signed in with a new session; every other one signs in again.
    reply.header('cache-control', 'no-store');
    return session === undefined ? { ok: true } : { ok: true, session };
  });
}

/** Rotates the install token on disk and returns the new one. */
export async function rotateTokenFile(home: string): Promise<string> {
  const token = generateToken();
  await writeToken(home, token);
  return token;
}
