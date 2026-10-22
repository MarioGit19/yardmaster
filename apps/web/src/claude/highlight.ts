import { useEffect, useState } from 'react';

export type Lang =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'json'
  | 'shellscript'
  | 'diff'
  | 'css'
  | 'html'
  | 'ruby'
  | 'python'
  | 'go'
  | 'rust'
  | 'sql'
  | 'yaml'
  | 'markdown';

/** A token: text, then optionally a color (`var(--shiki-…)`) and a shiki font-style bit set. */
export type Token = [content: string, color?: string, fontStyle?: number];
export type TokenLine = Token[];

export interface HighlightRequest {
  id: number;
  code: string;
  lang: Lang;
}
export interface HighlightResponse {
  id: number;
  lines: TokenLine[] | null;
}

const ALIASES: Record<string, Lang> = {
  ts: 'typescript',
  typescript: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  shellscript: 'shellscript',
  console: 'shellscript',
  diff: 'diff',
  patch: 'diff',
  css: 'css',
  html: 'html',
  rb: 'ruby',
  ruby: 'ruby',
  py: 'python',
  python: 'python',
  go: 'go',
  rs: 'rust',
  rust: 'rust',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
};

/** The grammar for a fence's info string (`ts`, `bash`, …), or null to show plain text. */
export function langFor(info: string | null | undefined): Lang | null {
  if (!info) return null;
  return ALIASES[info.trim().toLowerCase()] ?? null;
}

/** Longer code is shown plain: highlighting it isn't worth the worker's time. */
export const MAX_HIGHLIGHT_CHARS = 20_000;
const CACHE_SIZE = 400;

const cache = new Map<string, TokenLine[] | null>();
const inflight = new Map<number, { key: string; done: (lines: TokenLine[] | null) => void }>();
const waiters = new Map<string, Set<(lines: TokenLine[] | null) => void>>();
let worker: Worker | null | undefined;
let nextId = 0;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') {
    worker = null;
    return worker;
  }
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
      const job = inflight.get(event.data.id);
      if (!job) return;
      inflight.delete(event.data.id);
      job.done(event.data.lines);
    };
    worker.onerror = () => {
      // Plain code from now on; waiting blocks stay plain.
      for (const job of inflight.values()) job.done(null);
      inflight.clear();
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

function remember(key: string, lines: TokenLine[] | null): void {
  cache.set(key, lines);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
}

/** Cached tokens for `code`, or undefined if they haven't been computed. */
export function cachedTokens(code: string, lang: Lang): TokenLine[] | null | undefined {
  return cache.get(`${lang}\0${code}`);
}

function request(
  code: string,
  lang: Lang,
  onDone: (lines: TokenLine[] | null) => void,
): () => void {
  const key = `${lang}\0${code}`;
  let set = waiters.get(key);
  if (!set) {
    set = new Set();
    waiters.set(key, set);
    const w = getWorker();
    const finish = (lines: TokenLine[] | null) => {
      remember(key, lines);
      const listeners = waiters.get(key);
      waiters.delete(key);
      for (const listener of listeners ?? []) listener(lines);
    };
    if (!w) {
      queueMicrotask(() => finish(null));
    } else {
      const id = nextId++;
      inflight.set(id, { key, done: finish });
      w.postMessage({ id, code, lang } satisfies HighlightRequest);
    }
  }
  set.add(onDone);
  return () => set.delete(onDone);
}

/** Highlighted lines for `code`, null while pending, unsupported or failed. */
export function useHighlight(code: string, lang: Lang | null): TokenLine[] | null {
  const highlightable = lang !== null && code.length <= MAX_HIGHLIGHT_CHARS;
  const cached = highlightable ? cachedTokens(code, lang) : null;
  const [lines, setLines] = useState<{ key: string; lines: TokenLine[] | null } | null>(null);
  const key = `${lang}\0${code}`;

  useEffect(() => {
    if (!highlightable || cached !== undefined) return;
    return request(code, lang, (result) => setLines({ key, lines: result }));
  }, [code, lang, key, highlightable, cached]);

  if (cached !== undefined) return cached;
  return lines?.key === key ? lines.lines : null;
}
