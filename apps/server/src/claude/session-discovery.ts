import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeSettingsPath } from '@yardmaster/hook';
import {
  type ClaudeSession,
  isAutomaticSessionName,
  type SessionHistoryEntry,
  SessionRegistryEntry,
  type SessionStatus,
} from '@yardmaster/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { BoardStore } from '../store.js';
import { type PathResolver, projectForCwd, resolveDir } from './project-lookup.js';
import { hasRunningWork } from './session-reducer.js';

export const DISCOVERY_INTERVAL_MS = 10_000;
/** How often `claude agents --json` runs. */
export const AGENTS_INTERVAL_MS = 30_000;
/** How often an on-demand refresh may run it. */
export const AGENTS_REFRESH_MS = 5_000;
/** After a failed run, the registry files serve until this much later: Claude Code may update. */
export const AGENTS_RETRY_MS = 10 * 60_000;
/** Hooks are async: a board status younger than this may just be ahead of, or behind, the list. */
export const RECONCILE_GRACE_MS = 30_000;
const AGENTS_TIMEOUT_MS = 5_000;
const AGENTS_MAX_OUTPUT = 4 * 1024 * 1024;
/** How long a project's `listSessions` result is reused. */
export const HISTORY_TTL_MS = 60_000;
export const HISTORY_LIMIT = 20;
/** The most sessions listed to fill `HISTORY_LIMIT` past ones around those already on the board. */
export const HISTORY_LISTING_MAX = 200;
/** Registry files are a few hundred bytes; anything far larger isn't one. */
const MAX_REGISTRY_FILE = 64 * 1024;
const TITLE_MAX = 120;

/** Lists a project's past sessions; returns raw `SDKSessionInfo`-shaped items. */
export type HistoryLister = (dir: string, limit: number) => Promise<unknown[]>;
/** The stdout of `claude agents --json`; rejects when it can't run. */
export type AgentLister = () => Promise<string>;

export interface SessionDiscoveryOptions {
  store: BoardStore;
  logger: Pick<FastifyBaseLogger, 'warn' | 'debug'>;
  /** Defaults to `<claudeConfigDir>/sessions`. */
  registryDir?: string;
  /** Defaults to `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claudeConfigDir?: string;
  isAlive?: (pid: number) => boolean;
  /** Defaults to the Agent SDK's `listSessions`; null turns history off. */
  listHistory?: HistoryLister | null;
  /** Defaults to running `claude agents --json`; null keeps to the registry files. */
  listAgents?: AgentLister | null;
  intervalMs?: number;
  agentsIntervalMs?: number;
  historyTtlMs?: number;
  now?: () => number;
  resolvePath?: PathResolver;
}

interface Discovered {
  pid: number;
  /** `updatedAt` of our last write; anything newer means hooks are driving the session. */
  writtenAt: number;
}

/**
 * Finds live Claude Code sessions through `claude agents --json`, or the optional
 * `~/.claude/sessions/<pid>.json` registry where that isn't available (PRD §6.4), so sessions
 * started before Yardmaster still show up, and ends them when their process is gone. Hooks stay
 * the source of truth: the list fills gaps, sets the status of sessions no hook has reported on,
 * and corrects a status that has stopped matching it. Also keeps a per-project list of recent
 * sessions from the SDK for the history browser.
 */
export class SessionDiscovery {
  private readonly store: BoardStore;
  private readonly log: SessionDiscoveryOptions['logger'];
  private readonly registryDir: string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly listHistory: HistoryLister | null;
  private readonly intervalMs: number;
  private readonly historyTtlMs: number;
  private readonly now: () => number;
  private readonly resolvePath: PathResolver;
  private readonly discovered = new Map<string, Discovered>();
  private readonly histories = new Map<
    string,
    { at: number; limit: number; entries: SessionHistoryEntry[] }
  >();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();
  private registryAvailable: boolean | null = null;
  private readonly listAgents: AgentLister | null;
  private readonly agentsIntervalMs: number;
  private agentsAt = Number.NEGATIVE_INFINITY;
  private agentsRetryAt = Number.NEGATIVE_INFINITY;
  private refreshWanted = false;

  constructor(options: SessionDiscoveryOptions) {
    this.store = options.store;
    this.log = options.logger;
    const configDir =
      options.claudeConfigDir ?? dirname(claudeSettingsPath(process.env, homedir()));
    this.registryDir = options.registryDir ?? join(configDir, 'sessions');
    this.isAlive = options.isAlive ?? processAlive;
    this.listHistory = options.listHistory === undefined ? sdkListSessions : options.listHistory;
    this.listAgents = options.listAgents === undefined ? runClaudeAgents : options.listAgents;
    this.agentsIntervalMs = options.agentsIntervalMs ?? AGENTS_INTERVAL_MS;
    this.intervalMs = options.intervalMs ?? DISCOVERY_INTERVAL_MS;
    this.historyTtlMs = options.historyTtlMs ?? HISTORY_TTL_MS;
    this.now = options.now ?? Date.now;
    this.resolvePath = options.resolvePath ?? resolveDir;
  }

  /** Scans now, then every `intervalMs`. */
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** One scan of the registry plus a refresh of stale project histories. Never throws. */
  tick(): Promise<void> {
    this.running = this.running.then(async () => {
      try {
        await this.scan();
        await this.refreshHistories();
      } catch (err) {
        this.log.warn({ err }, 'session discovery failed');
      }
    });
    return this.running;
  }

  /** Asks the live list again now, at most every `AGENTS_REFRESH_MS`. Never throws. */
  refresh(): Promise<void> {
    if (this.now() - this.agentsAt < AGENTS_REFRESH_MS) return this.running;
    this.refreshWanted = true;
    return this.tick();
  }

  /** Cached recent sessions of a project, newest first. */
  history(projectId: string): SessionHistoryEntry[] {
    return this.histories.get(projectId)?.entries ?? [];
  }

  /**
   * Up to `HISTORY_LIMIT` past sessions of a project, leaving out `exclude` (the sessions on the
   * board). The listing reaches past them, so a project whose newest sessions are all on the board
   * still has a history. The cached listing is reused while it is fresh, long enough, and no
   * session of the project ended since.
   */
  async freshHistory(
    projectId: string,
    exclude: ReadonlySet<string> = new Set(),
  ): Promise<SessionHistoryEntry[]> {
    const limit = Math.min(HISTORY_LIMIT + exclude.size, HISTORY_LISTING_MAX);
    const cached = this.histories.get(projectId);
    const fresh =
      cached !== undefined &&
      this.now() - cached.at < this.historyTtlMs &&
      cached.limit >= limit &&
      !this.endedSince(projectId, cached.at);
    const entries = fresh ? cached.entries : await this.loadHistory(projectId, limit);
    return entries.filter((e) => !exclude.has(e.id)).slice(0, HISTORY_LIMIT);
  }

  private endedSince(projectId: string, at: number): boolean {
    for (const session of Object.values(this.store.state.sessions)) {
      if (session.projectId === projectId && session.endedAt !== null && session.endedAt >= at) {
        return true;
      }
    }
    return false;
  }

  /** Lists a project's recent sessions through the SDK now. */
  async loadHistory(projectId: string, limit = HISTORY_LIMIT): Promise<SessionHistoryEntry[]> {
    const project = this.store.state.projects[projectId];
    if (!project || this.listHistory === null) return [];
    let raw: unknown[];
    try {
      raw = await this.listHistory(project.path, limit);
    } catch (err) {
      this.log.debug({ err, projectId }, 'listSessions failed');
      return this.history(projectId);
    }
    const entries: SessionHistoryEntry[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const info = SdkSessionInfo.safeParse(item);
      if (!info.success) {
        this.log.debug({ projectId }, 'skipped malformed session info');
        continue;
      }
      entries.push(toHistoryEntry(projectId, info.data));
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    this.histories.set(projectId, { at: this.now(), limit, entries });
    return entries;
  }

  private async scan(): Promise<void> {
    const listing = await this.liveSessions();
    const ts = this.now();
    const seen = new Set<string>();
    // A session can appear twice (a stale file next to a resumed one): the live pid wins.
    const byId = new Map<string, { entry: SessionRegistryEntry; alive: boolean }>();
    for (const entry of listing?.entries ?? []) {
      const alive = this.isAlive(entry.pid);
      const prev = byId.get(entry.sessionId);
      if (!prev || (alive && !prev.alive)) byId.set(entry.sessionId, { entry, alive });
    }
    for (const { entry, alive } of byId.values()) {
      seen.add(entry.sessionId);
      if (alive) await this.applyAlive(entry, ts, listing?.reconcile ?? false);
      else this.applyDead(entry.sessionId, entry.pid, ts);
    }
    // Files can vanish with their process; check what we found earlier.
    for (const [id, { pid }] of this.discovered) {
      if (!seen.has(id) && !this.isAlive(pid)) this.applyDead(id, pid, ts);
    }
  }

  /**
   * What's live now: the agents list when it's due, the registry when the list isn't available,
   * and null between two runs of the list. Only the list is trusted to correct a status.
   */
  private async liveSessions(): Promise<{
    entries: SessionRegistryEntry[];
    reconcile: boolean;
  } | null> {
    const ts = this.now();
    if (this.listAgents === null || ts < this.agentsRetryAt) {
      return { entries: await this.readRegistry(), reconcile: false };
    }
    const wanted = this.refreshWanted;
    this.refreshWanted = false;
    if (!wanted && ts - this.agentsAt < this.agentsIntervalMs) return null;
    this.agentsAt = ts;
    const entries = await this.readAgents(this.listAgents);
    if (entries) return { entries, reconcile: true };
    this.agentsRetryAt = ts + AGENTS_RETRY_MS;
    return { entries: await this.readRegistry(), reconcile: false };
  }

  /** Valid rows of the list, or null when this Claude Code can't produce one. */
  private async readAgents(list: AgentLister): Promise<SessionRegistryEntry[] | null> {
    let rows: unknown;
    try {
      rows = JSON.parse(await list());
    } catch (err) {
      this.log.debug({ code: errorCode(err) }, 'claude agents --json unavailable');
      return null;
    }
    if (!Array.isArray(rows)) {
      this.log.debug('claude agents --json did not print a list');
      return null;
    }
    const entries: SessionRegistryEntry[] = [];
    for (const row of rows) {
      const parsed = SessionRegistryEntry.safeParse(row);
      if (parsed.success) entries.push(parsed.data);
      else this.log.debug({ issues: parsed.error.issues.length }, 'skipped a claude agents row');
    }
    return entries;
  }

  private async applyAlive(
    entry: SessionRegistryEntry,
    ts: number,
    reconcile: boolean,
  ): Promise<void> {
    const { sessionId: id, pid } = entry;
    const name = entry.name ? clipLine(entry.name) : null;
    // Claude Code names a session `<folder>-<code>` until the user renames it.
    const automatic = name !== null && isAutomaticSessionName(name, entry.cwd);
    const title = automatic ? name : null;
    const customTitle = automatic ? null : name;
    const existing = this.store.state.sessions[id];
    if (!existing) {
      const projectId = entry.cwd
        ? await projectForCwd(this.store, entry.cwd, ts, this.resolvePath)
        : null;
      this.store.upsertSession({
        id,
        origin: 'terminal',
        projectId,
        cwd: entry.cwd ?? null,
        claudePid: pid,
        title,
        customTitle,
        status: liveStatus(entry) ?? { kind: 'unknown', alive: true },
        startedAt: ts,
        updatedAt: ts,
      });
      this.discovered.set(id, { pid, writtenAt: ts });
      return;
    }

    const known = this.discovered.get(id);
    // A new process for an ended session is a resume; the old process exiting isn't news.
    const resumed = existing.status.kind === 'ended' && existing.claudePid !== pid;
    if (existing.status.kind === 'ended' && !resumed) return;
    const owned = resumed || (known !== undefined && known.writtenAt === existing.updatedAt);

    const fields: Partial<ClaudeSession> = {};
    if (existing.claudePid !== pid) fields.claudePid = pid;
    if (existing.cwd === null && entry.cwd) fields.cwd = entry.cwd;
    if (existing.projectId === null && entry.cwd) {
      const projectId = await projectForCwd(this.store, entry.cwd, ts, this.resolvePath);
      if (projectId) fields.projectId = projectId;
    }
    if (existing.title === null && title) fields.title = title;
    if (customTitle && customTitle !== existing.customTitle) fields.customTitle = customTitle;
    let updatedAt = existing.updatedAt;
    if (owned) {
      const status = liveStatus(entry) ?? (resumed ? { kind: 'unknown', alive: true } : null);
      if (status && (resumed || status.kind !== existing.status.kind)) {
        fields.status = status;
        fields.endedAt = null;
        updatedAt = Math.max(ts, existing.updatedAt);
      }
    }
    const corrected = reconcile && !owned ? correctedStatus(existing, entry, ts) : null;
    if (corrected) {
      this.log.debug({ from: existing.status.kind, to: corrected.kind }, 'corrected a status');
      fields.status = corrected;
      fields.currentTool = null;
      updatedAt = ts;
    }
    if (Object.keys(fields).length > 0) {
      // Metadata fills aren't session activity; only a status change moves `updatedAt`.
      this.store.updateSession(id, { ...fields, updatedAt });
    }
    // Tracked either way so a vanished file still ends it; -1 never matches `updatedAt`.
    const wrote = owned || corrected !== null;
    this.discovered.set(id, { pid, writtenAt: wrote ? updatedAt : (known?.writtenAt ?? -1) });
  }

  private applyDead(id: string, pid: number, ts: number): void {
    this.discovered.delete(id);
    const session = this.store.state.sessions[id];
    if (!session || session.status.kind === 'ended') return;
    // Hooks may have tied the session to a newer process since.
    if (session.claudePid !== null && session.claudePid !== pid) return;
    this.store.setSessionStatus(id, { kind: 'ended' }, ts);
  }

  /** Valid registry entries, or none when the registry doesn't exist. */
  private async readRegistry(): Promise<SessionRegistryEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.registryDir);
    } catch (err) {
      if (this.registryAvailable !== false) {
        this.log.debug({ code: errorCode(err) }, 'no claude session registry');
      }
      this.registryAvailable = false;
      return [];
    }
    this.registryAvailable = true;
    const entries: SessionRegistryEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const entry = await this.readEntry(join(this.registryDir, name));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  private async readEntry(path: string): Promise<SessionRegistryEntry | null> {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_REGISTRY_FILE) return null;
      const parsed = SessionRegistryEntry.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (parsed.success) return parsed.data;
      this.log.debug({ issues: parsed.error.issues.length }, 'skipped malformed registry file');
    } catch (err) {
      // Files come and go as sessions start and exit; a half-written one parses next time.
      this.log.debug({ code: errorCode(err) }, 'skipped unreadable registry file');
    }
    return null;
  }

  private async refreshHistories(): Promise<void> {
    if (this.listHistory === null) return;
    const ts = this.now();
    for (const id of this.histories.keys()) {
      if (!this.store.state.projects[id]) this.histories.delete(id);
    }
    for (const project of Object.values(this.store.state.projects)) {
      const cached = this.histories.get(project.id);
      if (cached && ts - cached.at < this.historyTtlMs) continue;
      await this.loadHistory(project.id, cached?.limit);
    }
  }
}

/** What Claude Code says of a live session; null when that says nothing about the board. */
function liveStatus(entry: SessionRegistryEntry): SessionStatus | null {
  if (entry.status === 'busy') return { kind: 'working' };
  if (entry.status === 'idle') return { kind: 'idle' };
  if (entry.status !== 'waiting') return null;
  // An open slash-command panel is the user at the keyboard, not the session asking for them.
  if (entry.waitingFor === 'dialog open') return null;
  return /permission|sandbox|worker/i.test(entry.waitingFor ?? '')
    ? { kind: 'waiting_permission', approvalId: null }
    : { kind: 'waiting_input' };
}

/**
 * The status a live terminal session should have instead, or null to leave it: this repairs a
 * missed hook, it doesn't overrule one. A failure stays until the next turn, and an approval
 * the board holds stays until it's decided.
 */
function correctedStatus(
  session: ClaudeSession,
  entry: SessionRegistryEntry,
  now: number,
): SessionStatus | null {
  if (session.origin !== 'terminal' || now - session.updatedAt < RECONCILE_GRACE_MS) return null;
  const live = liveStatus(entry);
  const status = session.status;
  if (live === null || live.kind === status.kind) return null;
  if (status.kind === 'error' || status.kind === 'ended' || status.kind === 'interrupted') {
    return null;
  }
  if (status.kind === 'waiting_permission' && status.approvalId !== null) return null;
  switch (live.kind) {
    case 'idle':
      // The `idle_prompt` notification: an idle session waiting on its next prompt.
      return status.kind === 'waiting_input' ? null : live;
    case 'working':
      if (status.kind === 'tool' || status.kind === 'compacting') return null;
      return status.kind === 'idle' && hasRunningWork(session) ? null : live;
    default:
      return status.kind === 'waiting_input' || status.kind === 'waiting_permission' ? null : live;
  }
}

/** Signal 0 checks existence; EPERM means it exists under another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM';
  }
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

function clipLine(text: string): string | null {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

const OptionalText = z.string().max(100_000).optional().catch(undefined);
const OptionalTime = z.number().int().nonnegative().optional().catch(undefined);

/** The fields of the SDK's `SDKSessionInfo` we use, read defensively. */
const SdkSessionInfo = z.object({
  sessionId: z.string().min(1).max(256),
  summary: OptionalText,
  lastModified: z.number().int().nonnegative(),
  fileSize: OptionalTime,
  customTitle: OptionalText,
  firstPrompt: OptionalText,
  gitBranch: OptionalText,
  cwd: OptionalText,
  createdAt: OptionalTime,
});
type SdkSessionInfo = z.infer<typeof SdkSessionInfo>;

function toHistoryEntry(projectId: string, info: SdkSessionInfo): SessionHistoryEntry {
  const title = info.customTitle || info.summary;
  return {
    id: info.sessionId,
    projectId,
    title: title ? clipLine(title) : null,
    firstPrompt: info.firstPrompt ? clipLine(info.firstPrompt) : null,
    cwd: info.cwd ?? null,
    gitBranch: info.gitBranch ?? null,
    createdAt: info.createdAt ?? null,
    updatedAt: info.lastModified,
    fileSize: info.fileSize ?? null,
    tokens: null,
  };
}

/** Reads local session state only; no API call or login involved. */
const runClaudeAgents: AgentLister = () =>
  new Promise((resolve, reject) => {
    execFile(
      process.env.YARDMASTER_CLAUDE_BIN || 'claude',
      ['agents', '--json'],
      { timeout: AGENTS_TIMEOUT_MS, maxBuffer: AGENTS_MAX_OUTPUT, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

/** Reads local transcripts only; no API call or login involved. */
const sdkListSessions: HistoryLister = async (dir, limit) => {
  const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
  return listSessions({ dir, limit });
};
