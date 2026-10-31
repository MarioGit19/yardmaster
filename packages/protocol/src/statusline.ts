import { z } from 'zod';
import type { AccountUsage, SessionMeter, UsageWindow } from './domain.js';

// The JSON Claude Code gives a statusline command (https://code.claude.com/docs/en/statusline),
// as the forwarder passes it on. Most of it is optional and varies by plan and version, so one bad
// field drops that field, never the delivery.

const number = z.number().finite().nullish().catch(null);
const text = z.string().max(4096).nullish().catch(null);

const Window = z.looseObject({ used_percentage: number, resets_at: number }).nullish().catch(null);

export const StatuslinePayload = z.looseObject({
  session_id: z.string().min(1).max(256).nullish().catch(null),
  rate_limits: z.looseObject({ five_hour: Window, seven_day: Window }).nullish().catch(null),
  cost: z.looseObject({ total_cost_usd: number }).nullish().catch(null),
  context_window: z
    .looseObject({ used_percentage: number, context_window_size: number })
    .nullish()
    .catch(null),
  worktree: z
    .looseObject({
      name: text,
      path: text,
      branch: text,
      original_cwd: text,
      original_branch: text,
    })
    .nullish()
    .catch(null),
});
export type StatuslinePayload = z.infer<typeof StatuslinePayload>;

function usageWindow(window: z.infer<typeof Window>): UsageWindow | null {
  const percent = window?.used_percentage;
  const resetsAt = window?.resets_at;
  if (percent == null || resetsAt == null || percent < 0 || resetsAt <= 0) return null;
  return { usedPercent: percent, resetsAt: Math.round(resetsAt * 1000) };
}

/** The account's limits in a delivery, or null when it has none (API key, or before a reply). */
export function usageFromStatusline(payload: StatuslinePayload, at: number): AccountUsage | null {
  const fiveHour = usageWindow(payload.rate_limits?.five_hour);
  const sevenDay = usageWindow(payload.rate_limits?.seven_day);
  return fiveHour || sevenDay ? { fiveHour, sevenDay, at } : null;
}

/** What a delivery says about its own session. */
export function meterFromStatusline(payload: StatuslinePayload): SessionMeter {
  const cost = payload.cost?.total_cost_usd;
  const context = payload.context_window;
  const worktree = payload.worktree;
  return {
    costUsd: cost != null && cost >= 0 ? cost : null,
    contextPercent: context?.used_percentage ?? null,
    contextSize: context?.context_window_size ?? null,
    worktree:
      worktree?.name && worktree.path
        ? {
            name: worktree.name,
            path: worktree.path,
            branch: worktree.branch ?? null,
            originalCwd: worktree.original_cwd ?? null,
            originalBranch: worktree.original_branch ?? null,
          }
        : null,
  };
}
