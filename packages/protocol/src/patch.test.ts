import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BoardState } from './domain.js';
import { board, session } from './fixtures.test-helpers.js';
import {
  applyPatch,
  createDiffCollector,
  diffState,
  MAX_PATCH_DEPTH,
  PatchOp,
  PatchPath,
} from './patch.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Small key space so random ops collide with existing paths often.
const key = fc.constantFrom('a', 'b', 'c', 'd', 'sessions', 'id-1', 'id-2');
const path = fc.array(key, { minLength: 1, maxLength: 4 });
const leaf = fc.oneof(
  fc.integer(),
  fc.string({ maxLength: 4 }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer(), { maxLength: 3 }),
);
const { tree } = fc.letrec<{ tree: unknown; node: Record<string, unknown> }>((tie) => ({
  tree: fc.oneof({ depthSize: 'small' }, leaf, tie('node')),
  node: fc.dictionary(key, tie('tree'), { maxKeys: 4 }),
}));
const node = fc.dictionary(key, tree, { maxKeys: 4 });
const op: fc.Arbitrary<PatchOp> = fc.oneof(
  fc.record({ op: fc.constant('set' as const), path, value: tree }),
  fc.record({ op: fc.constant('merge' as const), path, value: node }),
  fc.record({ op: fc.constant('delete' as const), path }),
);

describe('applyPatch', () => {
  it('sets, merges and deletes at a path of ids', () => {
    const before = deepFreeze(clone(board));
    const after = applyPatch(before, [
      { op: 'set', path: ['sessions', session.id, 'title'], value: 'Renamed' },
      { op: 'merge', path: ['sessions', session.id, 'tokens'], value: { output: 99 } },
      { op: 'delete', path: ['ports', Object.keys(board.ports)[0] as string] },
    ]);
    const s = after.sessions[session.id];
    expect(s?.title).toBe('Renamed');
    expect(s?.tokens).toEqual({ ...session.tokens, output: 99 });
    expect(after.ports).toEqual({});
    expect(before).toEqual(board);
  });

  it('shares untouched branches', () => {
    const before = deepFreeze(clone(board));
    const after = applyPatch(before, [
      { op: 'set', path: ['sessions', session.id, 'title'], value: 'x' },
    ]);
    expect(after).not.toBe(before);
    expect(after.projects).toBe(before.projects);
    expect(after.terminals).toBe(before.terminals);
    expect(after.sessions[session.id]?.tokens).toBe(before.sessions[session.id]?.tokens);
  });

  it('creates missing parents for set and merge, ignores deletes of missing paths', () => {
    const before = deepFreeze({ a: 1 } as Record<string, unknown>);
    expect(applyPatch(before, [{ op: 'set', path: ['b', 'c'], value: 2 }])).toEqual({
      a: 1,
      b: { c: 2 },
    });
    expect(applyPatch(before, [{ op: 'merge', path: ['a'], value: { x: 1 } }])).toEqual({
      a: { x: 1 },
    });
    expect(applyPatch(before, [{ op: 'delete', path: ['b', 'c'] }])).toBe(before);
  });

  it('never touches the prototype', () => {
    const before = {} as Record<string, unknown>;
    const after = applyPatch(before, [
      { op: 'set', path: ['__proto__', 'polluted'], value: true },
      { op: 'merge', path: ['x'], value: JSON.parse('{"__proto__":{"polluted":true},"ok":1}') },
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(after).toEqual({ x: { ok: 1 } });
    expect(Object.getPrototypeOf(after.x)).toBe(Object.prototype);
  });

  it('never mutates its input (property)', () => {
    fc.assert(
      fc.property(node, fc.array(op, { maxLength: 8 }), (state, ops) => {
        const snapshot = clone(state);
        applyPatch(deepFreeze(state), ops);
        expect(state).toEqual(snapshot);
      }),
    );
  });
});

describe('PatchPath', () => {
  it('rejects empty, unsafe and too deep paths', () => {
    expect(PatchPath.safeParse([]).success).toBe(false);
    expect(PatchPath.safeParse(['__proto__']).success).toBe(false);
    expect(PatchPath.safeParse(Array(MAX_PATCH_DEPTH + 1).fill('a')).success).toBe(false);
    expect(PatchPath.safeParse(['sessions', 'id-1']).success).toBe(true);
  });
});

describe('diffState', () => {
  it('returns no ops for the same state', () => {
    expect(diffState(board, board)).toEqual([]);
  });

  it('emits one merge for several changed leaves of the same object', () => {
    const next = applyPatch(board, [
      { op: 'set', path: ['sessions', session.id, 'title'], value: 'x' },
      { op: 'set', path: ['sessions', session.id, 'model'], value: 'y' },
    ]);
    expect(diffState(board, next)).toEqual([
      { op: 'merge', path: ['sessions', session.id], value: { title: 'x', model: 'y' } },
    ]);
  });

  it('round-trips arbitrary states (property)', () => {
    fc.assert(
      fc.property(node, node, (prev, next) => {
        const ops = diffState(prev, next);
        for (const o of ops) expect(PatchOp.safeParse(o).success).toBe(true);
        expect(applyPatch(prev, ops)).toEqual(next);
      }),
    );
  });
});

describe('createDiffCollector', () => {
  it('applying the collected ops to the old state equals the new state (property)', () => {
    fc.assert(
      fc.property(node, fc.array(op, { maxLength: 12 }), (initial, ops) => {
        const old = deepFreeze(initial);
        const collector = createDiffCollector(old);
        for (const o of ops) {
          if (o.op === 'set') collector.set(o.path, o.value);
          else if (o.op === 'merge') collector.merge(o.path, o.value);
          else collector.delete(o.path);
        }
        const patch = collector.flush();
        expect(applyPatch(old, patch)).toEqual(collector.state);
        expect(applyPatch(old, patch)).toEqual(applyPatch(old, ops));
      }),
    );
  });

  it('holds across several flushes (property)', () => {
    fc.assert(
      fc.property(
        node,
        fc.array(fc.array(op, { maxLength: 5 }), { maxLength: 4 }),
        (initial, batches) => {
          const collector = createDiffCollector(deepFreeze(initial));
          let mirror: Record<string, unknown> = initial;
          for (const batch of batches) {
            collector.apply(batch);
            mirror = applyPatch(mirror, collector.flush());
            expect(mirror).toEqual(collector.state);
            expect(collector.dirty).toBe(false);
          }
        },
      ),
    );
  });

  it('collects board mutations as a minimal patch', () => {
    const collector = createDiffCollector<BoardState>(board);
    expect(collector.dirty).toBe(false);
    collector.set(['sessions', session.id, 'status'], { kind: 'working' });
    collector.set(['sessions', session.id, 'status'], { kind: 'idle' });
    collector.delete(['approvals', 'missing']);
    expect(collector.dirty).toBe(true);
    expect(collector.flush()).toEqual([
      { op: 'set', path: ['sessions', session.id, 'status'], value: { kind: 'idle' } },
    ]);
    expect(collector.flush()).toEqual([]);
  });

  it('accepts a replaced state built elsewhere', () => {
    const collector = createDiffCollector<BoardState>(board);
    const { [session.id]: _gone, ...sessions } = board.sessions;
    collector.replace({ ...board, sessions });
    expect(collector.flush()).toEqual([{ op: 'delete', path: ['sessions', session.id] }]);
  });
});
