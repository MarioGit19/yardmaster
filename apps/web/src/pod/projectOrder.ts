import { worktreeParent } from '@yardmaster/protocol';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useBoard, useBoardStore } from '../data/index.js';
import type { BoardStoreState } from '../data/store.js';
import { keepOrder } from '../order.js';
import type { KeyValueStorage } from '../prefs.js';
import { boardSettings } from '../settings/boardSettings.js';

const STORAGE_KEY = 'yardmaster.projectOrder';
const NO_PINS: readonly string[] = [];

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readSaved(storage: KeyValueStorage | undefined): readonly string[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export interface ProjectOrder {
  get(): readonly string[];
  /** Gives newcomers a place at the end. Everything else stays where it is. */
  latch(ids: readonly string[]): void;
  /** The user's own arrangement of `ids`, kept on this device. */
  save(ids: readonly string[]): void;
  subscribe(listener: () => void): () => void;
}

/**
 * The order the board keeps projects in. It only changes when new projects arrive or the user
 * moves one, so no status change can reorder the overview. Saved once the user has moved something;
 * until then each load starts from the most recently active.
 */
export function createProjectOrder(
  storage: KeyValueStorage | undefined = defaultStorage(),
): ProjectOrder {
  const listeners = new Set<() => void>();
  let held = readSaved(storage);
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const latch = (ids: readonly string[]) => {
    const known = new Set(held);
    const added = ids.filter((id) => !known.has(id));
    if (added.length === 0) return;
    held = [...held, ...added];
    emit();
  };
  return {
    get: () => held,
    latch,
    save(ids) {
      latch(ids);
      held = placeInOrder(held, ids);
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(held));
      } catch {
        // Storage can be full or disabled; the order still holds until a reload.
      }
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const projectOrder = createProjectOrder();

/** `held` with the places `ids` occupy refilled in `ids` order; projects off screen stay put. */
export function placeInOrder(held: readonly string[], ids: readonly string[]): string[] {
  const moved = new Set(ids);
  let next = 0;
  return held.map((id) => (moved.has(id) ? (ids[next++] ?? id) : id));
}

/** The overview's order: pinned projects first, each group in the held order. */
export function arrangeProjects(
  recent: readonly string[],
  held: readonly string[],
  pinned: readonly string[],
): string[] {
  const pins = new Set(pinned);
  const ordered = keepOrder(recent, held, (id) => id);
  return [...ordered.filter((id) => pins.has(id)), ...ordered.filter((id) => !pins.has(id))];
}

/** `order` with `id` swapped `by` places along its pinned or unpinned group; null at either end. */
export function nudgeProject(
  order: readonly string[],
  pinned: readonly string[],
  id: string,
  by: 1 | -1,
): string[] | null {
  const from = order.indexOf(id);
  const neighbour = order[from + by];
  if (from < 0 || neighbour === undefined) return null;
  if (pinned.includes(id) !== pinned.includes(neighbour)) return null;
  const next = [...order];
  next[from] = neighbour;
  next[from + by] = id;
  return next;
}

/** Project ids, most recently active first (no projects until the board loads). */
export function recentIds(s: BoardStoreState): string[] {
  if (!s.hydrated) return [];
  return Object.values(s.board.projects)
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
    .map((p) => p.id);
}

/** Each linked worktree with its main checkout, as `child parent` lines of ids. */
export function selectWorktreeLinks(s: BoardStoreState): string {
  const { projects } = s.board;
  return Object.values(projects)
    .flatMap((project) => {
      const parent = worktreeParent(project, projects);
      return parent ? [`${project.id} ${parent.id}`] : [];
    })
    .join('\n');
}

/** `order` with each linked worktree moved right behind its main checkout. */
export function besideParents(order: readonly string[], links: string): readonly string[] {
  if (links === '') return order;
  const parents = new Map(links.split('\n').map((line) => line.split(' ') as [string, string]));
  const present = new Set(order);
  const nested = (id: string) => present.has(parents.get(id) ?? '');
  return order.flatMap((id) => {
    if (nested(id)) return [];
    return [id, ...order.filter((child) => nested(child) && parents.get(child) === id)];
  });
}

export const usePinnedProjects = (): readonly string[] =>
  useSyncExternalStore(boardSettings.subscribe, boardSettings.get)?.pinnedProjects ?? NO_PINS;

/**
 * Every project in overview order, worktrees behind their main checkout. Whichever list asks first
 * on a load fixes the default. The selector settles the order, so a project overtaking another in
 * recency, many times a second on a busy board, re-renders nothing when the order stands.
 */
export function useProjectOrder(): readonly string[] {
  const store = useBoardStore();
  const held = useSyncExternalStore(projectOrder.subscribe, projectOrder.get);
  const pinned = usePinnedProjects();
  const links = useBoard(selectWorktreeLinks);
  const key = useBoard((s) =>
    besideParents(arrangeProjects(recentIds(s), held, pinned), links).join('\n'),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newcomer always changes `key`
  useEffect(() => projectOrder.latch(recentIds(store.getState())), [key, store]);
  return useMemo(() => (key === '' ? [] : key.split('\n')), [key]);
}
