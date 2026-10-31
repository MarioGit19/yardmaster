import { describe, expect, it } from 'vitest';
import { createAwayClock, LAST_ACTIVE_KEY } from './away.js';

const MINUTE = 60_000;

function setup(after: number | null = 20 * MINUTE, stored?: number) {
  const data = new Map<string, string>();
  if (stored !== undefined) data.set(LAST_ACTIVE_KEY, String(stored));
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
  let time = 100 * MINUTE;
  const clock = createAwayClock(
    storage,
    () => after,
    () => time,
  );
  return { clock, data, tick: (ms: number) => (time += ms) };
}

describe('createAwayClock', () => {
  it('has nothing to report the first time it runs', () => {
    const { clock, data } = setup();
    expect(clock.touch()).toBeNull();
    expect(data.get(LAST_ACTIVE_KEY)).toBe(String(100 * MINUTE));
  });

  it('reports the last activity once the board was left for long enough, once', () => {
    const { clock } = setup(20 * MINUTE, 75 * MINUTE);
    expect(clock.touch()).toBe(75 * MINUTE);
    expect(clock.touch()).toBeNull();
  });

  it('stays quiet before the threshold, and when turned off', () => {
    expect(setup(20 * MINUTE, 90 * MINUTE).clock.touch()).toBeNull();
    expect(setup(null, 10 * MINUTE).clock.touch()).toBeNull();
  });

  it('ignores a stored value that is not a number', () => {
    const { clock, data } = setup();
    data.set(LAST_ACTIVE_KEY, 'soon');
    expect(clock.touch()).toBeNull();
  });

  it('writes activity sparingly and keeps the rest on leaving', () => {
    const { clock, data, tick } = setup();
    clock.touch();
    tick(5_000);
    clock.touch();
    expect(data.get(LAST_ACTIVE_KEY)).toBe(String(100 * MINUTE));
    clock.flush();
    expect(data.get(LAST_ACTIVE_KEY)).toBe(String(100 * MINUTE + 5_000));
  });
});
