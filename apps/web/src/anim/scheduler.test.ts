import { describe, expect, it, vi } from 'vitest';
import { createScheduler, MAX_DT } from './scheduler.js';

/** A manual rAF: `flush(now)` runs the pending frame. */
function fakeHost() {
  let next = 1;
  const pending = new Map<number, (now: number) => void>();
  return {
    host: {
      request: vi.fn((callback: (now: number) => void) => {
        const id = next++;
        pending.set(id, callback);
        return id;
      }),
      cancel: vi.fn((id: number) => {
        pending.delete(id);
      }),
    },
    get pending() {
      return pending.size;
    },
    flush(now: number) {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(now);
    },
  };
}

describe('createScheduler', () => {
  it('requests no frames until something registers', () => {
    const raf = fakeHost();
    const scheduler = createScheduler(raf.host);
    expect(scheduler.running).toBe(false);
    expect(raf.host.request).not.toHaveBeenCalled();
  });

  it('runs every registered callback on one shared frame', () => {
    const raf = fakeHost();
    const scheduler = createScheduler(raf.host);
    const a = vi.fn();
    const b = vi.fn();
    scheduler.add(a);
    scheduler.add(b);
    expect(scheduler.size).toBe(2);
    expect(raf.pending).toBe(1);

    raf.flush(1000);
    expect(a).toHaveBeenCalledWith(1000, 0);
    expect(b).toHaveBeenCalledWith(1000, 0);
    expect(raf.pending).toBe(1);

    raf.flush(1016);
    expect(a).toHaveBeenLastCalledWith(1016, 16);
    expect(raf.host.request).toHaveBeenCalledTimes(3);
  });

  it('stops the loop when the last callback unregisters', () => {
    const raf = fakeHost();
    const scheduler = createScheduler(raf.host);
    const a = vi.fn();
    const handle = scheduler.add(a);
    raf.flush(0);
    handle.remove();
    expect(scheduler.size).toBe(0);
    expect(scheduler.running).toBe(false);
    expect(raf.pending).toBe(0);
    expect(raf.host.cancel).toHaveBeenCalled();
    raf.flush(16);
    expect(a).toHaveBeenCalledTimes(1);
    // Removing twice is harmless.
    handle.remove();
    expect(scheduler.activeCount).toBe(0);
  });

  it('keeps inactive callbacks registered without frames', () => {
    const raf = fakeHost();
    const scheduler = createScheduler(raf.host);
    const a = vi.fn();
    const handle = scheduler.add(a, false);
    expect(scheduler.size).toBe(1);
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.running).toBe(false);

    handle.setActive(true);
    expect(scheduler.running).toBe(true);
    raf.flush(50);
    expect(a).toHaveBeenCalledWith(50, 0);

    handle.setActive(false);
    expect(scheduler.running).toBe(false);
    handle.setActive(true);
    raf.flush(500);
    // Reactivation restarts the clock rather than reporting the gap.
    expect(a).toHaveBeenLastCalledWith(500, 0);
  });

  it('pauses and resumes without losing registrations', () => {
    const raf = fakeHost();
    const scheduler = createScheduler(raf.host);
    const a = vi.fn();
    scheduler.add(a);
    raf.flush(0);
    scheduler.setPaused(true);
    expect(scheduler.running).toBe(false);
    expect(raf.pending).toBe(0);
    expect(scheduler.size).toBe(1);

    scheduler.setPaused(false);
    expect(scheduler.running).toBe(true);
    raf.flush(10_000);
    expect(a).toHaveBeenLastCalledWith(10_000, 0);
  });

  it('does not start while paused, even when callbacks register', () => {
    const raf = fakeHost();
    const scheduler = createScheduler(raf.host);
    scheduler.setPaused(true);
    scheduler.add(vi.fn());
    expect(scheduler.running).toBe(false);
    scheduler.setPaused(false);
    expect(scheduler.running).toBe(true);
  });

  it('clamps dt after a stall', () => {
    const raf = fakeHost();
    const scheduler = createScheduler(raf.host);
    const a = vi.fn();
    scheduler.add(a);
    raf.flush(0);
    raf.flush(5000);
    expect(a).toHaveBeenLastCalledWith(5000, MAX_DT);
  });

  it('lets callbacks unregister themselves and others mid-frame', () => {
    const raf = fakeHost();
    const scheduler = createScheduler(raf.host);
    const b = vi.fn();
    const handles: { remove(): void }[] = [];
    handles.push(
      scheduler.add(() => {
        handles[0]?.remove();
        handles[1]?.remove();
      }),
    );
    handles.push(scheduler.add(b));
    raf.flush(0);
    expect(b).not.toHaveBeenCalled();
    expect(scheduler.size).toBe(0);
    expect(scheduler.running).toBe(false);
  });

  it('keeps running when one callback throws', () => {
    const raf = fakeHost();
    const scheduler = createScheduler(raf.host);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = vi.fn();
    scheduler.add(() => {
      throw new Error('boom');
    });
    scheduler.add(b);
    raf.flush(0);
    expect(b).toHaveBeenCalled();
    expect(scheduler.running).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
