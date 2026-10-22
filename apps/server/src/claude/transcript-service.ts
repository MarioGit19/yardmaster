import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeSettingsPath } from '@c-board/hook';
import {
  type ChatMessage,
  type ClaudeSession,
  decodeChatMessage,
  sessionIdFromStream,
  type TokenUsage,
  transcriptStreamId,
} from '@c-board/protocol';
import { watch } from 'chokidar';
import type { FastifyBaseLogger } from 'fastify';
import { type ReadResult, RingBuffer } from '../ring-buffer.js';
import type { BoardStore } from '../store.js';
import { JsonlTail } from './jsonl-tail.js';
import {
  entryUuid,
  normalizeEntry,
  parseTranscriptLine,
  UsageTracker,
} from './transcript-normalize.js';

/** Normalized messages kept per session, as serialized JSON. */
export const TRANSCRIPT_BUFFER_BYTES = 8 * 1024 * 1024;
/** History loads running at once (sessions arrive in bursts on boot). */
const MAX_PARALLEL_LOADS = 4;

/** Loads a session's history; returns raw entries, or null to fall back to the JSONL file. */
export type HistoryLoader = (sessionId: string, dir: string) => Promise<unknown[] | null>;
/** Watches a file; `onChange` fires on writes. Returns a function that stops watching. */
export type FileWatcher = (path: string, onChange: () => void) => () => Promise<void>;

export type TranscriptDataListener = (streamId: string, seq: number, chunk: string) => void;

export interface TranscriptServiceOptions {
  store: BoardStore;
  logger: Pick<FastifyBaseLogger, 'warn' | 'debug'>;
  /** Defaults to the Agent SDK's `getSessionMessages`. */
  loadHistory?: HistoryLoader | null;
  watchFile?: FileWatcher;
  /** Where `projects/<encoded-cwd>/<id>.jsonl` lives when a session has no transcript path. */
  claudeConfigDir?: string;
  maxBytes?: number;
}

interface Tracked {
  id: string;
  path: string | null;
  tail: JsonlTail | null;
  ring: RingBuffer;
  seen: Set<string>;
  usage: UsageTracker;
  model: string | null;
  /** Serializes loads and reads for the session. */
  queue: Promise<void>;
  unwatch: (() => Promise<void>) | null;
  ended: boolean;
  closed: boolean;
}

/**
 * Reads Claude transcripts for every known session: history first (SDK, else the raw
 * JSONL), then a live tail of `transcript_path`. Messages are normalized, buffered per
 * session and published as the `transcript:<sessionId>` stream; token usage and context
 * size go to the session in the store.
 */
export class TranscriptService {
  private readonly store: BoardStore;
  private readonly log: TranscriptServiceOptions['logger'];
  private readonly loadHistory: HistoryLoader | null;
  private readonly watchFile: FileWatcher;
  private readonly configDir: string;
  private readonly maxBytes: number;
  private readonly sessions = new Map<string, Tracked>();
  private readonly listeners = new Set<TranscriptDataListener>();
  private readonly detach: () => void;
  private loads = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(options: TranscriptServiceOptions) {
    this.store = options.store;
    this.log = options.logger;
    this.loadHistory = options.loadHistory === undefined ? sdkHistory : options.loadHistory;
    this.watchFile = options.watchFile ?? chokidarWatch;
    this.configDir = options.claudeConfigDir ?? dirname(claudeSettingsPath(process.env, homedir()));
    this.maxBytes = options.maxBytes ?? TRANSCRIPT_BUFFER_BYTES;
    this.detach = this.store.onPatch((ops) => {
      const ids = new Set<string>();
      for (const op of ops) {
        if (op.path[0] !== 'sessions') continue;
        if (op.path[1] !== undefined) ids.add(op.path[1]);
        else for (const id of this.knownIds()) ids.add(id);
      }
      for (const id of ids) this.sync(id);
    });
    for (const id of Object.keys(this.store.state.sessions)) this.sync(id);
  }

  /** Buffered messages of a `transcript:` stream from `fromSeq`, like `OutputBuffers.read`. */
  read(streamId: string, fromSeq?: number): ReadResult | undefined {
    const id = sessionIdFromStream(streamId);
    return id === null ? undefined : this.sessions.get(id)?.ring.read(fromSeq);
  }

  nextSeq(streamId: string): number {
    const id = sessionIdFromStream(streamId);
    return (id === null ? undefined : this.sessions.get(id)?.ring.nextSeq) ?? 0;
  }

  /** Every message currently buffered for a session. */
  messages(sessionId: string): ChatMessage[] {
    const ring = this.sessions.get(sessionId)?.ring;
    if (!ring) return [];
    const out: ChatMessage[] = [];
    for (const { chunk } of ring.read(0).chunks) {
      const message = decodeChatMessage(chunk);
      if (message) out.push(message);
    }
    return out;
  }

  onData(listener: TranscriptDataListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once every queued load and read has finished. */
  async idle(): Promise<void> {
    for (;;) {
      const queues = [...this.sessions.values()].map((t) => t.queue);
      await Promise.all(queues);
      const now = [...this.sessions.values()].map((t) => t.queue);
      if (now.length === queues.length && now.every((q, i) => q === queues[i])) return;
    }
  }

  async close(): Promise<void> {
    this.detach();
    const all = [...this.sessions.values()];
    for (const tracked of all) tracked.closed = true;
    await Promise.all(all.map((t) => t.queue));
    await Promise.all(all.map((t) => this.stopWatching(t)));
    this.sessions.clear();
  }

  private knownIds(): string[] {
    return [...new Set([...this.sessions.keys(), ...Object.keys(this.store.state.sessions)])];
  }

  private sync(id: string): void {
    const session = this.store.state.sessions[id];
    let tracked = this.sessions.get(id);
    if (!session) {
      if (tracked) this.forget(tracked);
      return;
    }
    if (!tracked) {
      tracked = {
        id,
        path: null,
        tail: null,
        ring: new RingBuffer(this.maxBytes),
        seen: new Set(),
        usage: new UsageTracker(),
        model: session.model,
        queue: Promise.resolve(),
        unwatch: null,
        ended: false,
        closed: false,
      };
      this.sessions.set(id, tracked);
      const t = tracked;
      this.enqueue(t, () => this.limited(() => this.load(t)));
      return;
    }
    const t = tracked;
    const path = this.pathFor(session);
    if (path !== null && path !== t.path && !t.ended) {
      // The hook reported the real path after we guessed one from the cwd.
      this.enqueue(t, () => this.repoint(t, path));
    }
    if (session.status.kind === 'ended' && !t.ended) {
      t.ended = true;
      this.enqueue(t, async () => {
        await this.readNew(t);
        await this.stopWatching(t);
      });
    }
  }

  private async load(t: Tracked): Promise<void> {
    const session = this.store.state.sessions[t.id];
    if (t.closed || !session) return;
    const path = this.pathFor(session);
    t.path = path;
    t.tail = path === null ? null : new JsonlTail(path);
    t.ended ||= session.status.kind === 'ended';

    const sizeBefore = path === null ? 0 : await fileSize(path);
    const history = session.cwd ? await this.history(t.id, session.cwd) : null;
    if (history !== null && history.length > 0) {
      this.ingest(t, history);
      await t.tail?.seekToLineEnd(sizeBefore);
    }
    await this.readNew(t);
    if (!t.ended) this.startWatching(t);
  }

  private async history(id: string, cwd: string): Promise<unknown[] | null> {
    if (this.loadHistory === null) return null;
    try {
      const entries = await this.loadHistory(id, cwd);
      return Array.isArray(entries) ? entries : null;
    } catch (err) {
      this.log.debug({ err, sessionId: id }, 'sdk history unavailable, reading jsonl');
      return null;
    }
  }

  private async repoint(t: Tracked, path: string): Promise<void> {
    if (t.closed || path === t.path) return;
    await this.stopWatching(t);
    t.path = path;
    // Lines already read through the SDK or the old path are skipped by uuid.
    t.tail = new JsonlTail(path);
    await this.readNew(t);
    if (!t.ended) this.startWatching(t);
  }

  private async readNew(t: Tracked): Promise<void> {
    if (t.closed || !t.tail) return;
    try {
      const { lines } = await t.tail.read();
      const entries: unknown[] = [];
      for (const line of lines) {
        const entry = parseTranscriptLine(line);
        if (entry === null) this.log.debug({ sessionId: t.id }, 'skipped bad transcript line');
        else entries.push(entry);
      }
      this.ingest(t, entries);
    } catch (err) {
      this.log.warn({ err, sessionId: t.id }, 'transcript read failed');
    }
  }

  private ingest(t: Tracked, entries: readonly unknown[]): void {
    if (t.closed) return;
    const streamId = transcriptStreamId(t.id);
    let usageChanged = false;
    let model: string | null = null;
    for (const entry of entries) {
      const uuid = entryUuid(entry);
      if (uuid !== null) {
        if (t.seen.has(uuid)) continue;
        t.seen.add(uuid);
      }
      for (const message of normalizeEntry(entry)) {
        if (message.kind !== 'user' && message.kind !== 'tool_result') {
          if (message.usage) {
            const key = message.messageId ?? message.uuid ?? message.id;
            usageChanged = t.usage.add(key, message.usage) || usageChanged;
          }
          if (message.model && message.model !== '<synthetic>') model = message.model;
        }
        const chunk = JSON.stringify(message);
        const seq = t.ring.append(chunk);
        for (const listener of this.listeners) listener(streamId, seq, chunk);
      }
    }
    this.publish(t, usageChanged, model);
  }

  private publish(t: Tracked, usageChanged: boolean, model: string | null): void {
    const session = this.store.state.sessions[t.id];
    if (!session) return;
    const fields: { tokens?: TokenUsage; contextTokens?: number | null; model?: string } = {};
    if (usageChanged) {
      fields.tokens = t.usage.tokens;
      fields.contextTokens = t.usage.contextTokens;
    }
    if (model !== null && model !== session.model) fields.model = model;
    if (Object.keys(fields).length === 0) return;
    // Transcript reads aren't session activity: keep `updatedAt` as the hooks set it.
    this.store.updateSession(t.id, { ...fields, updatedAt: session.updatedAt });
  }

  private startWatching(t: Tracked): void {
    if (t.closed || t.unwatch || t.path === null) return;
    try {
      t.unwatch = this.watchFile(t.path, () => this.enqueue(t, () => this.readNew(t)));
    } catch (err) {
      this.log.warn({ err, sessionId: t.id }, 'could not watch transcript');
    }
  }

  private async stopWatching(t: Tracked): Promise<void> {
    const unwatch = t.unwatch;
    t.unwatch = null;
    await unwatch?.().catch((err: unknown) => this.log.debug({ err }, 'unwatch failed'));
  }

  private forget(t: Tracked): void {
    t.closed = true;
    this.sessions.delete(t.id);
    this.enqueue(t, () => this.stopWatching(t));
  }

  private enqueue(t: Tracked, task: () => Promise<void>): void {
    t.queue = t.queue
      .then(task)
      .catch((err: unknown) => this.log.warn({ err, sessionId: t.id }, 'transcript task failed'));
  }

  /** Runs `task` once fewer than `MAX_PARALLEL_LOADS` loads are in flight. */
  private async limited(task: () => Promise<void>): Promise<void> {
    while (this.loads >= MAX_PARALLEL_LOADS) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.loads += 1;
    try {
      await task();
    } finally {
      this.loads -= 1;
      this.waiting.shift()?.();
    }
  }

  private pathFor(session: ClaudeSession): string | null {
    if (session.transcriptPath) return session.transcriptPath;
    if (!session.cwd) return null;
    return join(this.configDir, 'projects', encodeProjectDir(session.cwd), `${session.id}.jsonl`);
  }
}

/** Claude Code's folder name for a cwd under `~/.claude/projects`. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** History through the Agent SDK; it reads the local transcript, no API call or login involved. */
const sdkHistory: HistoryLoader = async (sessionId, dir) => {
  const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
  return getSessionMessages(sessionId, { dir });
};

const chokidarWatch: FileWatcher = (path, onChange) => {
  const watcher = watch(path, { ignoreInitial: true, persistent: true });
  watcher.on('add', onChange).on('change', onChange);
  watcher.on('error', () => {});
  return () => watcher.close();
};
