import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  FOLDER_UNTRUSTED,
  type FolderTrustReview,
  TRUST_CHANGED,
  TRUST_FILES,
  type TrustFile,
  type TrustFinding,
  type TrustFindingKind,
} from '@yardmaster/protocol';
import { z } from 'zod';
import type { ActionResult } from '../actions.js';

// Folder trust for board Claude sessions (PLAN 14.4). A headless SDK run loads the folder's
// `.claude/settings*.json` and `.mcp.json` without the CLI's trust dialog, so a cloned repo could
// run a `SessionStart` hook or pre-approve Bash the moment a board session starts there.

/** Settings files larger than this aren't parsed; the folder needs a review. */
export const TRUST_FILE_MAX_BYTES = 1_000_000;
const MAX_FINDINGS = 200;
const MAX_TRUSTED = 500;
const DETAIL_MAX = 2_000;
const LABEL_MAX = 300;

/** Settings keys whose value is a command Claude Code runs. */
const COMMAND_KEYS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'otelHeadersHelper',
  'statusLine',
  'fileSuggestion',
] as const;
/** Settings keys that make Claude Code start a project's MCP servers or load plugins. */
const MCP_KEYS = ['enableAllProjectMcpServers', 'enabledMcpjsonServers', 'mcpServers'] as const;
const PLUGIN_KEYS = ['enabledPlugins', 'extraKnownMarketplaces'] as const;
/** Permission modes that don't ask before every risky tool. */
const ASKING_MODES = new Set(['default', 'plan']);

/** A file's contents, `null` when it doesn't exist. Throws when it exists but can't be read. */
export type TrustFileReader = (path: string) => Promise<string | null>;

export const readTrustFile: TrustFileReader = async (path) => {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    if (info.size > TRUST_FILE_MAX_BYTES) throw new OversizedFile('too large');
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

class OversizedFile extends Error {}

export interface FolderScan {
  findings: TrustFinding[];
  truncated: boolean;
  /** sha256 over everything that can run code or widen permissions, values included. */
  hash: string;
}

const Obj = z.record(z.string(), z.unknown());
const HookEntry = z.looseObject({
  matcher: z.string().optional().catch(undefined),
  hooks: z.array(z.unknown()).optional().catch(undefined),
});
const HookCommand = z.looseObject({
  type: z.string().optional().catch(undefined),
  command: z.string().optional().catch(undefined),
  url: z.string().optional().catch(undefined),
  prompt: z.string().optional().catch(undefined),
});
const McpServer = z.looseObject({
  command: z.string().optional().catch(undefined),
  args: z.array(z.unknown()).optional().catch(undefined),
  url: z.string().optional().catch(undefined),
});

/** Reads the folder's settings and lists what can run code or widen permissions. Never throws. */
export async function scanFolder(
  folder: string,
  read: TrustFileReader = readTrustFile,
): Promise<FolderScan> {
  const findings: TrustFinding[] = [];
  const hashed: unknown[] = [];
  for (const file of TRUST_FILES) {
    let text: string | null;
    try {
      text = await read(join(folder, file));
    } catch (error) {
      const why = error instanceof OversizedFile ? 'Too large to check' : 'Could not be read';
      findings.push(finding(file, 'unreadable', why, null));
      hashed.push([file, why]);
      continue;
    }
    if (text === null) continue;
    if (text.length > TRUST_FILE_MAX_BYTES) {
      findings.push(finding(file, 'unreadable', 'Too large to check', null));
      hashed.push([file, 'raw', sha256(text)]);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      findings.push(finding(file, 'unreadable', 'Not valid JSON', null));
      hashed.push([file, 'raw', sha256(text)]);
      continue;
    }
    const top = Obj.safeParse(json);
    if (!top.success) {
      findings.push(finding(file, 'unreadable', 'Not a JSON object', null));
      hashed.push([file, 'raw', sha256(text)]);
      continue;
    }
    const risky =
      file === '.mcp.json'
        ? scanMcpFile(file, top.data, findings)
        : scanSettings(file, top.data, findings);
    if (Object.keys(risky).length > 0) hashed.push([file, risky]);
  }
  return {
    findings: findings.slice(0, MAX_FINDINGS),
    truncated: findings.length > MAX_FINDINGS,
    hash: sha256(canonical(hashed)),
  };
}

/** The risky part of a settings file, for the hash; findings are appended as found. */
function scanSettings(
  file: TrustFile,
  settings: Record<string, unknown>,
  out: TrustFinding[],
): Record<string, unknown> {
  const risky: Record<string, unknown> = {};
  const take = (key: string, value: unknown) => {
    if (!isEmpty(value)) risky[key] = value;
    return !isEmpty(value);
  };

  if (take('hooks', settings.hooks)) {
    const hooks = Obj.safeParse(settings.hooks);
    if (!hooks.success) out.push(finding(file, 'hook', 'Hooks', describe(settings.hooks)));
    else {
      for (const [event, entries] of Object.entries(hooks.data)) {
        if (isEmpty(entries)) continue;
        const commands = hookCommands(entries);
        const label = `${event} hook`;
        if (commands.length === 0) out.push(finding(file, 'hook', label, describe(entries)));
        for (const command of commands) out.push(finding(file, 'hook', label, command));
      }
    }
  }

  const permissions = Obj.safeParse(settings.permissions);
  if (permissions.success) {
    const { allow, defaultMode, additionalDirectories } = permissions.data;
    const perms: Record<string, unknown> = {};
    if (!isEmpty(allow)) {
      perms.allow = allow;
      for (const rule of list(allow)) out.push(finding(file, 'allow', text(rule), null));
    }
    if (
      defaultMode !== undefined &&
      !(typeof defaultMode === 'string' && ASKING_MODES.has(defaultMode))
    ) {
      perms.defaultMode = defaultMode;
      out.push(finding(file, 'mode', text(defaultMode), null));
    }
    if (!isEmpty(additionalDirectories)) {
      perms.additionalDirectories = additionalDirectories;
      for (const dir of list(additionalDirectories)) {
        out.push(finding(file, 'directory', text(dir), null));
      }
    }
    if (Object.keys(perms).length > 0) risky.permissions = perms;
  } else if (take('permissions', settings.permissions)) {
    out.push(finding(file, 'allow', 'Permissions', describe(settings.permissions)));
  }

  for (const key of COMMAND_KEYS) {
    if (!take(key, settings[key])) continue;
    out.push(finding(file, 'command', key, commandOf(settings[key])));
  }

  if (take('env', settings.env)) {
    const env = Obj.safeParse(settings.env);
    // Names only: values may be secrets.
    if (env.success)
      for (const name of Object.keys(env.data)) out.push(finding(file, 'env', name, null));
    else out.push(finding(file, 'env', 'Environment', null));
  }

  for (const key of MCP_KEYS) {
    const value = settings[key];
    if (value === false || !take(key, value)) continue;
    if (key === 'mcpServers') scanServers(file, value, out);
    else if (key === 'enabledMcpjsonServers') {
      for (const name of list(value)) out.push(finding(file, 'mcp', `Enables ${text(name)}`, null));
    } else out.push(finding(file, 'mcp', 'Enables every server in .mcp.json', null));
  }

  for (const key of PLUGIN_KEYS) {
    if (!take(key, settings[key])) continue;
    const value = Obj.safeParse(settings[key]);
    const names = value.success ? Object.keys(value.data) : list(settings[key]).map(text);
    if (names.length === 0) out.push(finding(file, 'plugin', key, describe(settings[key])));
    for (const name of names) {
      const detail =
        key === 'extraKnownMarketplaces' && value.success ? describe(value.data[name]) : null;
      out.push(
        finding(file, 'plugin', key === 'enabledPlugins' ? name : `Marketplace ${name}`, detail),
      );
    }
  }
  return risky;
}

function scanMcpFile(
  file: TrustFile,
  json: Record<string, unknown>,
  out: TrustFinding[],
): Record<string, unknown> {
  if (isEmpty(json.mcpServers)) return {};
  scanServers(file, json.mcpServers, out);
  return { mcpServers: json.mcpServers };
}

function scanServers(file: TrustFile, value: unknown, out: TrustFinding[]): void {
  const servers = Obj.safeParse(value);
  if (!servers.success) {
    out.push(finding(file, 'mcp', 'MCP servers', describe(value)));
    return;
  }
  for (const [name, raw] of Object.entries(servers.data)) {
    const server = McpServer.safeParse(raw);
    const detail = server.success
      ? server.data.command !== undefined
        ? [server.data.command, ...(server.data.args ?? []).map(text)].join(' ')
        : (server.data.url ?? describe(raw))
      : describe(raw);
    out.push(finding(file, 'mcp', name, detail));
  }
}

function hookCommands(entries: unknown): string[] {
  const commands: string[] = [];
  for (const entry of list(entries)) {
    const parsed = HookEntry.safeParse(entry);
    if (!parsed.success) {
      commands.push(describe(entry) ?? '');
      continue;
    }
    for (const hook of parsed.data.hooks ?? []) {
      const h = HookCommand.safeParse(hook);
      const what = h.success ? (h.data.command ?? h.data.url ?? h.data.prompt) : undefined;
      commands.push(what ?? describe(hook) ?? '');
    }
  }
  return commands.filter((c) => c !== '');
}

function commandOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const parsed = HookCommand.safeParse(value);
  return (parsed.success ? parsed.data.command : undefined) ?? describe(value);
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const text = (value: unknown): string =>
  (typeof value === 'string' ? value : (describe(value) ?? String(value))) || '(empty)';

function describe(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function finding(
  file: TrustFile,
  kind: TrustFindingKind,
  label: string,
  detail: string | null,
): TrustFinding {
  return {
    file,
    kind,
    label: clip(label, LABEL_MAX) || kind,
    detail: detail === null ? null : clip(detail, DETAIL_MAX),
  };
}

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** JSON with sorted object keys, so the hash doesn't depend on key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const TrustedEntry = z.object({
  path: z.string().min(1).max(4_096),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  at: z.number(),
});
type TrustedEntry = z.infer<typeof TrustedEntry>;

export interface FolderTrustOptions {
  /** The stored list (the `trust.folders` setting in board.db, under `~/.yardmaster`). */
  load: () => unknown;
  save: (list: TrustedEntry[]) => void;
  read?: TrustFileReader;
  now?: () => number;
}

export const TRUSTED_FOLDERS_KEY = 'trust.folders';

/**
 * The board's own trusted-folders list. A folder whose settings can't run code or widen
 * permissions is trusted silently; any other needs the user's yes for exactly what was found,
 * and asks again once that changes.
 */
export class FolderTrust {
  private readonly load: () => unknown;
  private readonly save: (list: TrustedEntry[]) => void;
  private readonly read: TrustFileReader;
  private readonly now: () => number;

  constructor(options: FolderTrustOptions) {
    this.load = options.load;
    this.save = options.save;
    this.read = options.read ?? readTrustFile;
    this.now = options.now ?? Date.now;
  }

  /** `null` when a board session may start in `folder`, otherwise what the card lists. */
  async review(folder: string): Promise<FolderTrustReview | null> {
    const path = resolve(folder);
    const scan = await scanFolder(path, this.read);
    if (scan.findings.length === 0) return null;
    if (this.entries().some((e) => e.path === path && e.hash === scan.hash)) return null;
    return { path, hash: scan.hash, findings: scan.findings, truncated: scan.truncated };
  }

  /** Trusts `folder` as reviewed; the files changed since: `trust_changed` with a new review. */
  async trust(folder: string, hash: string): Promise<ActionResult> {
    const path = resolve(folder);
    const review = await this.review(path);
    // Already trusted, or nothing risky is left: fine as it is.
    if (review === null) return { ok: true };
    if (review.hash !== hash) return { ok: false, error: TRUST_CHANGED, trust: review };
    const rest = this.entries().filter((e) => e.path !== path);
    this.save([...rest, { path, hash, at: this.now() }].slice(-MAX_TRUSTED));
    return { ok: true };
  }

  private entries(): TrustedEntry[] {
    const raw = this.load();
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const parsed = TrustedEntry.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }
}

export const untrusted = (trust: FolderTrustReview) =>
  ({ ok: false, error: FOLDER_UNTRUSTED, trust }) as const;
