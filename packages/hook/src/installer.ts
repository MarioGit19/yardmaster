import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Observer events from PRD §6.1. `PermissionRequest` is away mode only and installed separately. */
export const OBSERVER_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
] as const;

/** Our handlers are recognised by this name in their command. */
export const HOOK_MARKER = 'yardmaster-hook';
/** The hook's name before the rename to Yardmaster: an install replaces those handlers. */
export const LEGACY_HOOK_MARKER = 'c-board-hook';
export const HOOK_TIMEOUT_S = 5;
/** Away mode's `PermissionRequest` handler. */
export const AWAY_EVENT = 'PermissionRequest';
export const AWAY_FLAG = '--permission';
/** Above the longest wait the board allows (300 s) plus the script's slack. */
export const AWAY_HOOK_TIMEOUT_S = 330;
export const DEFAULT_HOOK_PATH = fileURLToPath(new URL('../bin/yardmaster-hook', import.meta.url));

export class InvalidSettingsError extends Error {}

/** `CLAUDE_CONFIG_DIR` or `~/.claude`. Only `settings.json` is read there, never credentials. */
export function claudeSettingsPath(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return join(dir ? dir : join(home, '.claude'), 'settings.json');
}

/** The handler command for a script path, quoted for the shell Claude Code runs it in. */
export function hookCommand(scriptPath: string = DEFAULT_HOOK_PATH): string {
  return /^[\w@%+=:,./-]+$/.test(scriptPath)
    ? scriptPath
    : `'${scriptPath.replaceAll("'", `'\\''`)}'`;
}

const Handler = z.looseObject({ command: z.unknown().optional() });
const Group = z.looseObject({ hooks: z.array(z.unknown()).optional() });
const Settings = z.looseObject({
  hooks: z.record(z.string(), z.array(z.unknown())).optional(),
});

type Json = Record<string, unknown>;
type HookMap = Record<string, unknown[]>;

/** True for a handler command that runs our hook script, under its new name or its old one. */
export function isHookCommand(command: string): boolean {
  return command.includes(HOOK_MARKER) || command.includes(LEGACY_HOOK_MARKER);
}

function isOurs(handler: unknown): boolean {
  const parsed = Handler.safeParse(handler);
  return (
    parsed.success && typeof parsed.data.command === 'string' && isHookCommand(parsed.data.command)
  );
}

function groupHandlers(group: unknown): unknown[] {
  const parsed = Group.safeParse(group);
  return parsed.success ? (parsed.data.hooks ?? []) : [];
}

/** Parses settings.json text. A missing file is an empty object; anything unparseable throws. */
export function parseSettings(raw: string | undefined): Json {
  if (raw === undefined || raw.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new InvalidSettingsError(
      `is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidSettingsError('is not a JSON object');
  }
  if (!Settings.safeParse(value).success) {
    throw new InvalidSettingsError('has a "hooks" key that is not an object of arrays');
  }
  return value as Json;
}

function desiredGroup(event: string, command: string): Json {
  // The permission hook is synchronous: Claude Code waits for its decision.
  return event === AWAY_EVENT
    ? {
        hooks: [
          { type: 'command', command: `${command} ${AWAY_FLAG}`, timeout: AWAY_HOOK_TIMEOUT_S },
        ],
      }
    : { hooks: [{ type: 'command', command, async: true, timeout: HOOK_TIMEOUT_S }] };
}

function isDesired(group: unknown, event: string, command: string): boolean {
  return JSON.stringify(group) === JSON.stringify(desiredGroup(event, command));
}

function isInstalled(groups: unknown[], event: string, command: string): boolean {
  return countOurs(groups) === 1 && groups.some((group) => isDesired(group, event, command));
}

/** Removes our handlers from an event's groups, dropping groups we emptied. */
function stripOurs(groups: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const group of groups) {
    const handlers = groupHandlers(group);
    if (!handlers.some(isOurs)) {
      out.push(group);
      continue;
    }
    const rest = handlers.filter((handler) => !isOurs(handler));
    if (rest.length > 0) out.push({ ...(group as Json), hooks: rest });
  }
  return out;
}

function countOurs(groups: unknown[]): number {
  return groups.reduce<number>((n, group) => n + groupHandlers(group).filter(isOurs).length, 0);
}

export interface Plan {
  before: string | undefined;
  after: string;
  changed: boolean;
}

function serialize(settings: Json): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function plan(raw: string | undefined, settings: Json, changed: boolean): Plan {
  return { before: raw, after: changed ? serialize(settings) : (raw ?? ''), changed };
}

export interface InstallOptions {
  /** Also add the away-mode `PermissionRequest` handler. Without it, that event is left alone. */
  away?: boolean;
}

export function planInstall(
  raw: string | undefined,
  command = hookCommand(),
  options: InstallOptions = {},
): Plan {
  const settings = parseSettings(raw);
  const hooks: HookMap = { ...((settings.hooks as HookMap | undefined) ?? {}) };
  let changed = false;
  const events: readonly string[] = options.away
    ? [...OBSERVER_EVENTS, AWAY_EVENT]
    : OBSERVER_EVENTS;
  for (const event of events) {
    const groups = hooks[event] ?? [];
    // Already exactly one handler of ours, in the shape we'd write: leave the event alone.
    if (isInstalled(groups, event, command)) continue;
    hooks[event] = [...stripOurs(groups), desiredGroup(event, command)];
    changed = true;
  }
  return plan(raw, changed ? { ...settings, hooks } : settings, changed);
}

/** Removes every Yardmaster handler, including an away-mode `PermissionRequest` one. */
export function planUninstall(raw: string | undefined): Plan {
  const settings = parseSettings(raw);
  const current = settings.hooks as HookMap | undefined;
  if (current === undefined) return plan(raw, settings, false);
  const hooks: HookMap = {};
  let changed = false;
  for (const [event, groups] of Object.entries(current)) {
    if (countOurs(groups) === 0) {
      hooks[event] = groups;
      continue;
    }
    changed = true;
    const rest = stripOurs(groups);
    if (rest.length > 0) hooks[event] = rest;
  }
  if (!changed) return plan(raw, settings, false);
  const next: Json = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return plan(raw, next, true);
}

export interface HookStatus {
  installed: string[];
  missing: string[];
  /** Ours, but with a different command or shape than an install would write. */
  outdated: string[];
}

export function hookStatus(raw: string | undefined, command = hookCommand()): HookStatus {
  const hooks = (parseSettings(raw).hooks as HookMap | undefined) ?? {};
  const status: HookStatus = { installed: [], missing: [], outdated: [] };
  for (const event of OBSERVER_EVENTS) {
    const groups = hooks[event] ?? [];
    if (countOurs(groups) === 0) status.missing.push(event);
    else if (isInstalled(groups, event, command)) status.installed.push(event);
    else status.outdated.push(event);
  }
  return status;
}

/** The away-mode handler: absent, installed as an install would write it, or outdated. */
export function awayHookStatus(
  raw: string | undefined,
  command = hookCommand(),
): 'missing' | 'installed' | 'outdated' {
  const groups = (parseSettings(raw).hooks as HookMap | undefined)?.[AWAY_EVENT] ?? [];
  if (countOurs(groups) === 0) return 'missing';
  return isInstalled(groups, AWAY_EVENT, command) ? 'installed' : 'outdated';
}

export async function readSettings(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(/[-:]/g, '');
}

/**
 * Writes a plan's result, backing up the current file first. The write goes through a temp
 * file and a rename, and refuses if the file changed since it was planned.
 * Returns the backup path, if one was made.
 */
export async function applyPlan(
  path: string,
  planned: Plan,
  now = new Date(),
): Promise<string | undefined> {
  if (!planned.changed) return undefined;
  const current = await readSettings(path);
  if (current !== planned.before) {
    throw new InvalidSettingsError(
      'changed while Yardmaster was editing it; run the command again',
    );
  }
  let backup: string | undefined;
  let mode = 0o600;
  if (current === undefined) await mkdir(dirname(path), { recursive: true });
  else {
    mode = (await stat(path)).mode & 0o777;
    backup = `${path}.yardmaster-backup-${stamp(now)}`;
    await copyFile(path, backup);
  }
  const tmp = `${path}.yardmaster-tmp-${process.pid}`;
  await writeFile(tmp, planned.after, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
  return backup;
}

/** A unified diff of two texts, with 3 lines of context. Settings files are small, so LCS is fine. */
export function unifiedDiff(before: string, after: string, from: string, to: string): string {
  if (before === after) return '';
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  // lcs(i, j): length of the longest common subsequence of a[i..] and b[j..].
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  const lcs = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }
  type Op = { kind: ' ' | '-' | '+'; text: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] as string, ai: i++, bi: j++ });
    } else if (i < a.length && (j >= b.length || lcs(i + 1, j) >= lcs(i, j + 1))) {
      ops.push({ kind: '-', text: a[i] as string, ai: i++, bi: j });
    } else {
      ops.push({ kind: '+', text: b[j] as string, ai: i, bi: j++ });
    }
  }

  const CONTEXT = 3;
  const changes = ops.flatMap((op, index) => (op.kind === ' ' ? [] : [index]));
  const out = [`--- ${from}`, `+++ ${to}`];
  const change = (index: number) => changes[index] ?? 0;
  for (let c = 0; c < changes.length; ) {
    let last = c;
    // Merge changes separated by at most 2×CONTEXT unchanged lines into one hunk.
    while (last + 1 < changes.length && change(last + 1) - change(last) <= 2 * CONTEXT + 1) {
      last++;
    }
    const hunk = ops.slice(
      Math.max(0, change(c) - CONTEXT),
      Math.min(ops.length, change(last) + CONTEXT + 1),
    );
    const first = hunk[0] as Op;
    const aLen = hunk.filter((op) => op.kind !== '+').length;
    const bLen = hunk.filter((op) => op.kind !== '-').length;
    const aStart = aLen ? first.ai + 1 : first.ai;
    const bStart = bLen ? first.bi + 1 : first.bi;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.text}`);
    c = last + 1;
  }
  return `${out.join('\n')}\n`;
}
