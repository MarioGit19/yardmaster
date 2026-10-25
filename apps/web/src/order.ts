import { useEffect, useMemo, useRef } from 'react';

/**
 * `items` in the order of `previous` (by key), newcomers after them in the order they come; keys
 * that are gone drop out. Live lists re-sort by state, so a list the reader is working in plans
 * from this: an item keeps its place instead of moving under the finger or the pointer.
 */
export function keepOrder<T>(
  items: readonly T[],
  previous: readonly string[],
  key: (item: T) => string,
): T[] {
  const index = new Map(previous.map((k, i) => [k, i]));
  const known = items.filter((item) => index.has(key(item)));
  known.sort((a, b) => (index.get(key(a)) ?? 0) - (index.get(key(b)) ?? 0));
  return [...known, ...items.filter((item) => !index.has(key(item)))];
}

/**
 * `items` as they are while `held` is false; while it's true, in the order they had when it
 * turned true (`keepOrder`). `key` must be stable (a module-level function).
 */
export function useHeldOrder<T>(
  items: readonly T[],
  key: (item: T) => string,
  held: boolean,
): readonly T[] {
  const kept = useRef<readonly string[] | null>(null);
  const order = useMemo(
    () => (held && kept.current ? keepOrder(items, kept.current, key) : items),
    [items, key, held],
  );
  useEffect(() => {
    kept.current = held ? order.map(key) : null;
  }, [order, key, held]);
  return order;
}
