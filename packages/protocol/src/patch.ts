import { z } from 'zod';

/** Keys that could reach `Object.prototype` when used as property names. */
const UNSAFE_KEYS = new Set(['__proto__']);

/** Path of keys into `BoardState`, e.g. `['sessions', '<id>', 'status']`. */
export const PatchPath = z
  .array(
    z
      .string()
      .min(1)
      .max(256)
      .refine((key) => !UNSAFE_KEYS.has(key), 'unsafe path key'),
  )
  .min(1)
  .max(16);
export type PatchPath = z.infer<typeof PatchPath>;

export const MAX_PATCH_DEPTH = 16;

export const PatchOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: PatchPath, value: z.unknown() }),
  z.object({ op: z.literal('merge'), path: PatchPath, value: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('delete'), path: PatchPath }),
]);
export type PatchOp = z.infer<typeof PatchOp>;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeEntries(value: Obj): [string, unknown][] {
  return Object.entries(value).filter(([key]) => !UNSAFE_KEYS.has(key));
}

/**
 * Applies one op below `node`, copying only the objects along the path.
 * Missing or non-object intermediates become `{}` for `set`/`merge`;
 * `delete` of a missing path is a no-op.
 */
function applyAt(node: unknown, op: PatchOp, depth: number): unknown {
  const key = op.path[depth] as string;
  const last = depth === op.path.length - 1;
  const current = isObj(node) ? node : undefined;

  if (op.op === 'delete') {
    if (!current || !Object.hasOwn(current, key)) return node;
    if (last) {
      const { [key]: _removed, ...rest } = current;
      return rest;
    }
    const child = applyAt(current[key], op, depth + 1);
    return child === current[key] ? node : { ...current, [key]: child };
  }

  const base = current ?? {};
  let child: unknown;
  if (!last) {
    child = applyAt(base[key], op, depth + 1);
  } else if (op.op === 'set') {
    child = op.value;
  } else {
    const target = base[key];
    child = { ...(isObj(target) ? target : {}), ...Object.fromEntries(safeEntries(op.value)) };
  }
  return { ...base, [key]: child };
}

/**
 * Applies `ops` in order and returns the new state. The input is never
 * mutated; branches no op touches keep their identity. Ops with unsafe
 * keys are skipped.
 */
export function applyPatch<T>(state: T, ops: readonly PatchOp[]): T {
  let next: unknown = state;
  for (const op of ops) {
    if (op.path.length === 0 || op.path.some((key) => UNSAFE_KEYS.has(key))) continue;
    next = applyAt(next, op, 0);
  }
  return next as T;
}

/** Tagged unions (e.g. session status) switching variant are replaced whole. */
function sameVariant(a: Obj, b: Obj): boolean {
  return !('kind' in a || 'kind' in b) || Object.is(a.kind, b.kind);
}

function diffInto(prev: Obj, next: Obj, path: string[], ops: PatchOp[]): void {
  for (const key of Object.keys(prev)) {
    if (!Object.hasOwn(next, key)) ops.push({ op: 'delete', path: [...path, key] });
  }
  const changed: Obj = {};
  let changedCount = 0;
  for (const [key, value] of Object.entries(next)) {
    const before = prev[key];
    if (Object.hasOwn(prev, key) && Object.is(before, value)) continue;
    if (
      Object.hasOwn(prev, key) &&
      isObj(before) &&
      isObj(value) &&
      sameVariant(before, value) &&
      path.length + 1 < MAX_PATCH_DEPTH
    ) {
      diffInto(before, value, [...path, key], ops);
      continue;
    }
    changed[key] = value;
    changedCount++;
  }
  if (changedCount === 1) {
    const [key, value] = Object.entries(changed)[0] as [string, unknown];
    ops.push({ op: 'set', path: [...path, key], value });
  } else if (changedCount > 1 && path.length > 0) {
    ops.push({ op: 'merge', path, value: changed });
  } else if (changedCount > 1) {
    for (const [key, value] of Object.entries(changed)) ops.push({ op: 'set', path: [key], value });
  }
}

/**
 * Ops that turn `prev` into `next`. Relies on structural sharing: subtrees
 * with the same identity are skipped without being walked. Arrays,
 * primitives and objects whose `kind` changed are replaced whole.
 */
export function diffState(prev: Obj, next: Obj): PatchOp[] {
  const ops: PatchOp[] = [];
  if (prev !== next) diffInto(prev, next, [], ops);
  return ops;
}

export interface DiffCollector<T extends Obj> {
  readonly state: T;
  set(path: PatchPath, value: unknown): void;
  merge(path: PatchPath, value: Obj): void;
  delete(path: PatchPath): void;
  apply(ops: readonly PatchOp[]): void;
  /** Swap in a state built elsewhere (it should share structure with the current one). */
  replace(next: T): void;
  /** Whether anything changed since the last flush. */
  readonly dirty: boolean;
  /** Ops since the last flush, coalesced; resets the baseline. */
  flush(): PatchOp[];
}

/**
 * Wraps a state so every mutation is immutable and the store can emit the
 * accumulated change as a single patch, e.g. on its broadcast tick.
 */
export function createDiffCollector<T extends Obj>(initial: T): DiffCollector<T> {
  let baseline = initial;
  let state = initial;
  return {
    get state() {
      return state;
    },
    get dirty() {
      return state !== baseline;
    },
    set(path, value) {
      state = applyPatch(state, [{ op: 'set', path, value }]);
    },
    merge(path, value) {
      state = applyPatch(state, [{ op: 'merge', path, value }]);
    },
    delete(path) {
      state = applyPatch(state, [{ op: 'delete', path }]);
    },
    apply(ops) {
      state = applyPatch(state, ops);
    },
    replace(next) {
      state = next;
    },
    flush() {
      const ops = diffState(baseline, state);
      baseline = state;
      return ops;
    },
  };
}
