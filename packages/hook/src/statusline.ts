import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  InvalidSettingsError,
  type Plan,
  parseSettings,
  settingsPlan,
  shellQuote,
} from './installer.js';

/** Our `statusLine` is recognised by this script name in its command. */
export const STATUSLINE_MARKER = 'yardmaster-statusline';
export const DEFAULT_STATUSLINE_PATH = fileURLToPath(
  new URL('../bin/yardmaster-statusline', import.meta.url),
);

const Entry = z.looseObject({ type: z.literal('command'), command: z.string().min(1) });
type Entry = z.infer<typeof Entry>;

/** Splits a command into words. Only quoting matters: it reads back what `statuslineCommand` wrote. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      word = (word ?? '') + command.slice(i + 1, stop);
      i = stop;
    } else if (char === '\\' && i + 1 < command.length) {
      word = (word ?? '') + command[++i];
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

export function isStatuslineCommand(command: string): boolean {
  return basename(shellWords(command)[0] ?? '') === STATUSLINE_MARKER;
}

/** The forwarder's command, carrying the command it runs after forwarding. */
export function statuslineCommand(
  previous: string | null,
  scriptPath: string = DEFAULT_STATUSLINE_PATH,
): string {
  const script = shellQuote(scriptPath);
  return previous === null ? script : `${script} ${shellQuote(previous)}`;
}

function entryOf(settings: Record<string, unknown>): Entry | null {
  if (settings.statusLine === undefined) return null;
  const entry = Entry.safeParse(settings.statusLine);
  if (!entry.success) throw new InvalidSettingsError('has a "statusLine" that is not a command');
  return entry.data;
}

/** The command the forwarder runs, or null. Only meaningful for a forwarder's command. */
function previousOf(command: string): string | null {
  return shellWords(command)[1] ?? null;
}

/** Wraps the current statusline. Reinstalling keeps the command it already wraps. */
export function planStatuslineInstall(
  raw: string | undefined,
  scriptPath: string = DEFAULT_STATUSLINE_PATH,
): Plan {
  const settings = parseSettings(raw);
  const entry = entryOf(settings);
  const ours = entry !== null && isStatuslineCommand(entry.command);
  const previous = ours ? previousOf(entry.command) : (entry?.command ?? null);
  const command = statuslineCommand(previous, scriptPath);
  if (entry?.command === command) return settingsPlan(raw, settings, false);
  const statusLine = entry ? { ...entry, command } : { type: 'command', command };
  return settingsPlan(raw, { ...settings, statusLine }, true);
}

/** Puts the previous command back, or removes `statusLine` if there was none. */
export function planStatuslineUninstall(raw: string | undefined): Plan {
  const settings = parseSettings(raw);
  const entry = entryOf(settings);
  if (entry === null || !isStatuslineCommand(entry.command)) {
    return settingsPlan(raw, settings, false);
  }
  const previous = previousOf(entry.command);
  if (previous !== null) {
    return settingsPlan(raw, { ...settings, statusLine: { ...entry, command: previous } }, true);
  }
  const { statusLine: _removed, ...rest } = settings;
  return settingsPlan(raw, rest, true);
}

export interface StatuslineStatus {
  state: 'missing' | 'installed' | 'outdated';
  /** The user's own command, wrapped or not. */
  previous: string | null;
}

export function statuslineStatus(
  raw: string | undefined,
  scriptPath: string = DEFAULT_STATUSLINE_PATH,
): StatuslineStatus {
  const entry = entryOf(parseSettings(raw));
  if (entry === null) return { state: 'missing', previous: null };
  if (!isStatuslineCommand(entry.command)) return { state: 'missing', previous: entry.command };
  const previous = previousOf(entry.command);
  const current = entry.command === statuslineCommand(previous, scriptPath);
  return { state: current ? 'installed' : 'outdated', previous };
}
