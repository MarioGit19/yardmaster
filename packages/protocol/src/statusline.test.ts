import { describe, expect, it } from 'vitest';
import { meterFromStatusline, StatuslinePayload, usageFromStatusline } from './statusline.js';

const FULL = {
  session_id: '0f3c2a9e-5b7d-4c1e-9a8f-2d6b4e1c7a35',
  cwd: '/home/dev/acme-shop',
  cost: { total_cost_usd: 1.25, total_duration_ms: 45000 },
  context_window: { used_percentage: 8, context_window_size: 200000, current_usage: null },
  rate_limits: {
    five_hour: { used_percentage: 42.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 18, resets_at: 1738857600 },
    spend_limit: { used_percentage: 1 },
  },
  worktree: {
    name: 'my-feature',
    path: '/home/dev/acme-shop/.claude/worktrees/my-feature',
    branch: 'worktree-my-feature',
    original_cwd: '/home/dev/acme-shop',
    original_branch: 'main',
  },
  prompt_cache: { warm: true },
};

const parse = (raw: unknown) => StatuslinePayload.parse(raw);

describe('statusline payloads', () => {
  it('reads the limits, in milliseconds, and the session meter', () => {
    const payload = parse(FULL);
    expect(usageFromStatusline(payload, 5)).toEqual({
      fiveHour: { usedPercent: 42.5, resetsAt: 1738425600000 },
      sevenDay: { usedPercent: 18, resetsAt: 1738857600000 },
      at: 5,
    });
    expect(meterFromStatusline(payload)).toEqual({
      costUsd: 1.25,
      contextPercent: 8,
      contextSize: 200000,
      worktree: {
        name: 'my-feature',
        path: '/home/dev/acme-shop/.claude/worktrees/my-feature',
        branch: 'worktree-my-feature',
        originalCwd: '/home/dev/acme-shop',
        originalBranch: 'main',
      },
    });
  });

  it('has no usage on an API-key payload, which has no rate_limits', () => {
    const { rate_limits: _gone, ...rest } = FULL;
    expect(usageFromStatusline(parse(rest), 5)).toBeNull();
  });

  it('keeps the one window a plan reports', () => {
    const payload = parse({ rate_limits: { seven_day: FULL.rate_limits.seven_day } });
    expect(usageFromStatusline(payload, 5)).toMatchObject({ fiveHour: null });
  });

  it('drops a bad field, not the delivery', () => {
    const payload = StatuslinePayload.safeParse({
      ...FULL,
      cost: 'free',
      context_window: { used_percentage: 'lots' },
      rate_limits: { five_hour: { used_percentage: -3, resets_at: 1 }, seven_day: 7 },
      worktree: { name: 'no-path' },
    });
    expect(payload.success).toBe(true);
    if (!payload.success) return;
    expect(usageFromStatusline(payload.data, 5)).toBeNull();
    expect(meterFromStatusline(payload.data)).toEqual({
      costUsd: null,
      contextPercent: null,
      contextSize: null,
      worktree: null,
    });
  });

  it('turns down what is not an object', () => {
    expect(StatuslinePayload.safeParse('hello').success).toBe(false);
  });
});
