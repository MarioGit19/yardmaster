import { describe, expect, it, vi } from 'vitest';
import { BoardStore } from '../store.js';
import { ingestStatusline, type StatuslineIngestOptions } from './statusline-ingest.js';

const SESSION = '0f3c2a9e-5b7d-4c1e-9a8f-2d6b4e1c7a35';
const FIVE_HOUR = { used_percentage: 42, resets_at: 1738425600 };

function setup(overrides: Partial<StatuslineIngestOptions> = {}) {
  const store = new BoardStore({ autoFlush: false, now: () => 1000 });
  const onUsage = vi.fn();
  const onReceived = vi.fn();
  const warn = vi.fn();
  const options: StatuslineIngestOptions = {
    store,
    logger: { warn },
    apply: true,
    onUsage,
    onReceived,
    now: () => 2000,
    ...overrides,
  };
  return { store, onUsage, onReceived, warn, options };
}

describe('ingestStatusline', () => {
  it('sets the account usage with the time it was read', () => {
    const { store, onUsage, options } = setup();
    ingestStatusline({ rate_limits: { five_hour: FIVE_HOUR } }, options);
    expect(store.state.usage).toEqual({
      fiveHour: { usedPercent: 42, resetsAt: 1738425600000 },
      sevenDay: null,
      at: 2000,
    });
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it('refreshes "as of" on a repeat without saving it again', () => {
    const { store, onUsage, options } = setup();
    const raw = { rate_limits: { five_hour: FIVE_HOUR } };
    ingestStatusline(raw, options);
    ingestStatusline(raw, { ...options, now: () => 3000 });
    expect(store.state.usage?.at).toBe(3000);
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it('keeps the last reading when a delivery has no limits', () => {
    const { store, options } = setup();
    ingestStatusline({ rate_limits: { five_hour: FIVE_HOUR } }, options);
    ingestStatusline({ session_id: SESSION }, options);
    expect(store.state.usage?.fiveHour?.usedPercent).toBe(42);
  });

  it('meters a known session without counting as activity', () => {
    const { store, options } = setup();
    store.upsertSession({ id: SESSION, updatedAt: 500 });
    ingestStatusline(
      {
        session_id: SESSION,
        cost: { total_cost_usd: 0.5 },
        context_window: { used_percentage: 9 },
      },
      options,
    );
    const session = store.state.sessions[SESSION];
    expect(session?.meter).toMatchObject({ costUsd: 0.5, contextPercent: 9 });
    expect(session?.updatedAt).toBe(500);
  });

  it('never creates a session', () => {
    const { store, options } = setup();
    ingestStatusline({ session_id: SESSION, cost: { total_cost_usd: 0.5 } }, options);
    expect(store.state.sessions).toEqual({});
  });

  it('logs and skips bad input, and still counts it', () => {
    const { store, warn, onReceived, options } = setup();
    expect(() => ingestStatusline('nonsense', options)).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(onReceived).toHaveBeenCalledOnce();
    expect(store.state.usage).toBeNull();
  });

  it('leaves the synthetic board alone in demo mode', () => {
    const { store, onReceived, options } = setup({ apply: false });
    ingestStatusline({ rate_limits: { five_hour: FIVE_HOUR } }, options);
    expect(store.state.usage).toBeNull();
    expect(onReceived).toHaveBeenCalledOnce();
  });
});
