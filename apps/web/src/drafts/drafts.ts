import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/** Text typed into an input but not sent yet, kept across switching sessions, tabs and reloads. */
export interface Draft {
  text: string;
  updatedAt: number;
}

export interface DraftState {
  drafts: Readonly<Record<string, Draft>>;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DRAFTS_KEY = 'c-board:drafts';
export const DRAFT_PERSIST_MS = 300;
export const MAX_DRAFTS = 50;
/** Per draft, in UTF-16 code units (about 20 kB of text). Longer text is stored cut off. */
export const MAX_DRAFT_CHARS = 20_000;

/** Draft keys, one per input: a session's composer, and a project's new-session and new-terminal fields. */
export const draftKey = {
  session: (sessionId: string) => `session:${sessionId}`,
  newSession: (projectId: string) => `new-session:${projectId}`,
  newTerminal: (projectId: string) => `new-terminal:${projectId}`,
} as const;

export interface DraftStore extends StoreApi<DraftState> {
  get(key: string): string;
  /** Text that is only whitespace clears the draft. */
  set(key: string, text: string): void;
  clear(key: string): void;
  /** Hands a draft to another input (a terminal session's draft goes to its fork). */
  move(from: string, to: string): void;
  /** Writes pending changes now (the page is going away). */
  flush(): void;
}

export interface DraftStoreOptions {
  storage?: DraftStorage | undefined;
  now?: () => number;
  persistMs?: number;
}

function defaultStorage(): DraftStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function isDraft(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) return false;
  const { text, updatedAt } = value as Record<string, unknown>;
  return typeof text === 'string' && text.trim() !== '' && typeof updatedAt === 'number';
}

/** Keeps the newest `MAX_DRAFTS`, each cut to `MAX_DRAFT_CHARS`. */
function capped(drafts: Record<string, Draft>): Record<string, Draft> {
  const entries = Object.entries(drafts)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_DRAFTS)
    .map(([key, d]): [string, Draft] => [
      key,
      d.text.length > MAX_DRAFT_CHARS ? { ...d, text: d.text.slice(0, MAX_DRAFT_CHARS) } : d,
    ]);
  return Object.fromEntries(entries);
}

function load(storage: DraftStorage | undefined): Record<string, Draft> {
  try {
    const raw = storage?.getItem(DRAFTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const drafts: Record<string, Draft> = {};
    for (const [key, value] of Object.entries(parsed)) if (isDraft(value)) drafts[key] = value;
    return capped(drafts);
  } catch {
    // A stale or hand-edited entry starts empty rather than breaking the composer.
    return {};
  }
}

export function createDraftStore({
  storage = defaultStorage(),
  now = Date.now,
  persistMs = DRAFT_PERSIST_MS,
}: DraftStoreOptions = {}): DraftStore {
  const store = createStore<DraftState>()(() => ({ drafts: load(storage) }));
  let timer: ReturnType<typeof setTimeout> | null = null;

  const persist = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try {
      const drafts = capped({ ...store.getState().drafts });
      if (Object.keys(drafts).length === 0) storage?.removeItem(DRAFTS_KEY);
      else storage?.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      // Storage can be full or disabled; the drafts still live for this page.
    }
  };
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(persist, persistMs);
  };
  const write = (drafts: Record<string, Draft>) => {
    store.setState({ drafts });
    schedule();
  };
  const without = (key: string) => {
    const { [key]: _, ...rest } = store.getState().drafts;
    return rest;
  };

  return {
    ...store,
    get: (key) => store.getState().drafts[key]?.text ?? '',
    set(key, text) {
      const current = store.getState().drafts[key];
      if (text.trim() === '') {
        if (current) write(without(key));
        return;
      }
      if (current?.text === text) return;
      const next = { ...store.getState().drafts, [key]: { text, updatedAt: now() } };
      write(Object.keys(next).length > MAX_DRAFTS ? capped(next) : next);
    },
    clear(key) {
      if (store.getState().drafts[key]) write(without(key));
    },
    move(from, to) {
      const draft = store.getState().drafts[from];
      if (!draft || from === to) return;
      write({ ...without(from), [to]: { ...draft, updatedAt: now() } });
    },
    flush: () => {
      if (timer !== null) persist();
    },
  };
}

export const drafts: DraftStore = createDraftStore();

if (typeof window !== 'undefined') {
  // A reload inside the debounce window keeps the last keystrokes too.
  window.addEventListener('pagehide', () => drafts.flush());
}

/** Whether an input has an unsent draft, for the "Draft" marker. */
export function useHasDraft(key: string | null): boolean {
  return useStore(drafts, (s) => key !== null && s.drafts[key] !== undefined);
}

export function useDraftText(key: string | null): string {
  return useStore(drafts, (s) => (key === null ? '' : (s.drafts[key]?.text ?? '')));
}
