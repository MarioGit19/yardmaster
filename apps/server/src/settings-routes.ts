import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  applyPlan,
  claudeSettingsPath,
  hookCommand,
  hookStatus,
  InvalidSettingsError,
  type Plan,
  planInstall,
  readSettings,
  unifiedDiff,
} from '@c-board/hook';
import {
  AwayTimeoutSec,
  type BoardSettings,
  BoardSettingsPatch,
  DEFAULT_AWAY_TIMEOUT_SEC,
  DEFAULT_RETENTION_DAYS,
  HooksInstallRequest,
  type HooksInstallResponse,
  type HooksPlanResponse,
  type HooksStatusResponse,
  RetentionDays,
} from '@c-board/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { tildify } from './doctor.js';
import type { Persistence } from './persistence.js';
import { setSessionCookie } from './security.js';
import { generateToken, writeToken } from './token.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_KEY = 'retentionDays';
export const AWAY_MODE_KEY = 'awayMode';
export const AWAY_TIMEOUT_KEY = 'awayTimeoutSec';
export const HOOK_SEEN_KEY = 'setup.hookSeen';
export const EDITOR_SEEN_KEY = 'setup.editorSeen';

/** Claude's settings.json as the hooks routes see it. Demo mode swaps in an in-memory one. */
export interface HookSettingsFile {
  /** Shown to the user. */
  displayPath: string;
  /** The handler command an install writes. */
  command: string;
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
    command: '/opt/c-board/bin/c-board-hook',
    read: async () => text,
    apply: async (plan) => {
      if (!plan.changed) return undefined;
      if (text !== plan.before)
        throw new InvalidSettingsError('changed while c-board was editing it');
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

export function retentionMs(days: RetentionDays): number {
  return days * DAY_MS;
}

export interface SettingsRoutesOptions {
  persistence: Persistence;
  /** Settings loaded at boot; kept in sync with writes. */
  settings: Record<string, unknown>;
  hookSettings: HookSettingsFile;
  /** Rotates the token, or null when the board can't (demo mode). */
  rotateToken: (() => Promise<string>) | null;
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
      const plan = planInstall(raw, hookSettings.command);
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
      const plan = planInstall(raw, hookSettings.command);
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

  app.post('/api/token/rotate', async (_request, reply) => {
    if (!options.rotateToken) return reply.code(409).send({ error: 'demo' });
    const token = await options.rotateToken();
    app.log.info('rotated the install token from the board');
    // Keep this browser signed in; every other one has to sign in again.
    return setSessionCookie(reply.header('cache-control', 'no-store'), token).send({ ok: true });
  });
}

/** Rotates the install token on disk and returns the new one. */
export async function rotateTokenFile(home: string): Promise<string> {
  const token = generateToken();
  await writeToken(home, token);
  return token;
}
