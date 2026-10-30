import { describe, expect, it, vi } from 'vitest';
import type { KeyValueStorage } from '../prefs.js';
import { createSeenFailures } from './seenFailures.js';

function memory(initial?: string): KeyValueStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem() {
      return this.value;
    },
    setItem(_key, value) {
      this.value = value;
    },
  };
}

describe('createSeenFailures', () => {
  it('remembers a key across reloads and tells subscribers once', () => {
    const storage = memory();
    const seen = createSeenFailures(storage);
    const listener = vi.fn();
    seen.subscribe(listener);
    seen.mark('e-1');
    seen.mark('e-1');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(createSeenFailures(storage).get().has('e-1')).toBe(true);
  });

  it('starts empty on a damaged entry', () => {
    expect(createSeenFailures(memory('{nope')).get().size).toBe(0);
    expect(createSeenFailures(memory('{"a":1}')).get().size).toBe(0);
  });

  it('keeps the newest keys only', () => {
    const seen = createSeenFailures(memory());
    for (let i = 0; i < 305; i++) seen.mark(`e-${i}`);
    expect(seen.get().size).toBe(300);
    expect(seen.get().has('e-0')).toBe(false);
    expect(seen.get().has('e-304')).toBe(true);
  });
});
