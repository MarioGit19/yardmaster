import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../prefs.js';
import {
  arrangeProjects,
  besideParents,
  createProjectOrder,
  nudgeProject,
  placeInOrder,
  recentIds,
} from './projectOrder.js';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe('createProjectOrder', () => {
  it('appends newcomers and keeps everyone else in place', () => {
    const order = createProjectOrder(memoryStorage());
    order.latch(['b', 'a']);
    order.latch(['c', 'a', 'b']);
    expect(order.get()).toEqual(['b', 'a', 'c']);
  });

  it('only remembers an order the user set', () => {
    const storage = memoryStorage();
    const order = createProjectOrder(storage);
    order.latch(['a', 'b']);
    expect(createProjectOrder(storage).get()).toEqual([]);
    order.save(['b', 'a']);
    expect(createProjectOrder(storage).get()).toEqual(['b', 'a']);
  });

  it.each(['not json', '{"a":1}', '[1,2]', 'null'])('ignores a stored %s', (raw) => {
    const order = createProjectOrder(memoryStorage({ 'yardmaster.projectOrder': raw }));
    expect(order.get()).toEqual([]);
  });

  it('survives storage that throws', () => {
    const order = createProjectOrder({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    order.save(['a']);
    expect(order.get()).toEqual(['a']);
  });
});

describe('placeInOrder', () => {
  it('leaves projects that are off screen where they were', () => {
    expect(placeInOrder(['a', 'hidden', 'b', 'c'], ['c', 'a', 'b'])).toEqual([
      'c',
      'hidden',
      'a',
      'b',
    ]);
  });
});

describe('arrangeProjects', () => {
  it('puts pinned projects first, each group in the held order', () => {
    expect(arrangeProjects(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a'], ['b', 'c'])).toEqual([
      'c',
      'b',
      'd',
      'a',
    ]);
  });

  it('follows the most recently active until something is held', () => {
    expect(arrangeProjects(['z', 'a'], [], [])).toEqual(['z', 'a']);
  });

  it('puts a project nothing has held yet after the held ones', () => {
    expect(arrangeProjects(['new', 'a', 'b'], ['b', 'a'], [])).toEqual(['b', 'a', 'new']);
  });
});

describe('nudgeProject', () => {
  it('swaps a project with its neighbour', () => {
    expect(nudgeProject(['a', 'b', 'c'], [], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(nudgeProject(['a', 'b', 'c'], [], 'b', -1)).toEqual(['b', 'a', 'c']);
  });

  it('stops at either end and at the edge of the pinned group', () => {
    expect(nudgeProject(['a', 'b'], [], 'a', -1)).toBeNull();
    expect(nudgeProject(['a', 'b'], [], 'b', 1)).toBeNull();
    expect(nudgeProject(['a', 'b'], ['a'], 'b', -1)).toBeNull();
  });
});

describe('recentIds', () => {
  const project = (id: string, name: string, lastActivityAt: number | null) => ({
    id,
    name,
    lastActivityAt,
  });

  it('lists the most recently active first, by name on a tie', () => {
    const projects = {
      a: project('a', 'zen', 10),
      b: project('b', 'acme', 10),
      c: project('c', 'orbit', 30),
      d: project('d', 'never', null),
    };
    const state = { hydrated: true, board: { projects } } as never;
    expect(recentIds(state)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('has nothing to order before the board loads', () => {
    const state = { hydrated: false, board: { projects: { a: project('a', 'a', 1) } } } as never;
    expect(recentIds(state)).toEqual([]);
  });
});

describe('besideParents', () => {
  it('moves a worktree right behind its main checkout', () => {
    expect(besideParents(['tax', 'orbit', 'shop', 'promo'], 'tax shop\npromo shop')).toEqual([
      'orbit',
      'shop',
      'tax',
      'promo',
    ]);
  });

  it('leaves a worktree alone while its main checkout is not listed', () => {
    expect(besideParents(['tax', 'orbit'], 'tax shop')).toEqual(['tax', 'orbit']);
    expect(besideParents(['a', 'b'], '')).toEqual(['a', 'b']);
  });
});
