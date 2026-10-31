import type { ClaudeSession, SessionStatus, Terminal } from '@yardmaster/protocol';

/** Semantic status tones, DESIGN.md §2. Each maps to a `--st-*` token. */
export type Tone = 'work' | 'tool' | 'wait' | 'stale' | 'ok' | 'err' | 'idle';

export interface StatusView {
  tone: Tone;
  label: string;
}

export function sessionStatusView(status: SessionStatus): StatusView {
  switch (status.kind) {
    case 'idle':
      return { tone: 'idle', label: 'Idle' };
    case 'working':
      return { tone: 'work', label: 'Working' };
    case 'tool':
      return { tone: 'tool', label: `Using ${status.tool}` };
    case 'waiting_permission':
      return { tone: 'wait', label: 'Waiting for approval' };
    case 'waiting_input':
      return { tone: 'wait', label: 'Waiting for input' };
    case 'error':
      return { tone: 'err', label: status.reason === 'rate_limit' ? 'Rate limited' : 'Error' };
    case 'compacting':
      return { tone: 'work', label: 'Compacting' };
    case 'unknown':
      return { tone: 'idle', label: status.alive ? 'Running' : 'Unknown' };
    case 'ended':
      return { tone: 'idle', label: 'Ended' };
    case 'interrupted':
      return { tone: 'idle', label: 'Interrupted' };
  }
}

const RANK: Record<Tone, number> = { wait: 5, err: 4, tool: 3, work: 3, stale: 2, ok: 1, idle: 0 };

/** The more urgent of two tones. */
export const rankTone = (a: Tone, b: Tone): Tone => (RANK[b] > RANK[a] ? b : a);

/** A project's tone: the highest-priority status among its children (wait > err > work). */
export function projectTone(
  sessions: readonly ClaudeSession[],
  terminals: readonly Terminal[],
): Tone {
  let best: Tone = 'idle';
  const consider = (tone: Tone) => {
    if (RANK[tone] > RANK[best]) best = tone;
  };
  for (const session of sessions) {
    const { tone } = sessionStatusView(session.status);
    consider(tone === 'tool' ? 'work' : tone);
  }
  for (const terminal of terminals) {
    if (terminal.exitCode !== null && terminal.exitCode !== 0) consider('err');
  }
  return best;
}

const TONE_LABEL: Record<Tone, string> = {
  work: 'Running',
  tool: 'Running',
  wait: 'Needs you',
  stale: 'Stale',
  ok: 'Done, unseen',
  err: 'Failed',
  idle: 'Quiet',
};

export const toneLabel = (tone: Tone) => TONE_LABEL[tone];

export function totalTokens(session: Pick<ClaudeSession, 'tokens'>): number {
  const { input, output, cacheRead, cacheCreation } = session.tokens;
  return input + output + cacheRead + cacheCreation;
}

/** Tokens and dollars are counted here, not billed: every figure is labelled as an estimate. */
export const TOKEN_ESTIMATE_HINT = 'Estimate from the session transcript';
export const COST_ESTIMATE_HINT = 'Estimated list price, from Claude Code. Not a bill.';

export const tokenEstimate = (tokens: number) => `≈${formatCount(tokens)} tok`;

export const formatCost = (usd: number) =>
  `≈$${usd < 10 ? usd.toFixed(2) : Math.round(usd).toLocaleString('en-US')}`;

/** Tokens and estimated cost across a project's sessions; cost is null when none reported one. */
export function projectBurn(sessions: readonly ClaudeSession[]) {
  let tokens = 0;
  let costUsd: number | null = null;
  for (const session of sessions) {
    tokens += totalTokens(session);
    const cost = session.meter?.costUsd;
    if (cost != null) costUsd = (costUsd ?? 0) + cost;
  }
  return { tokens, costUsd };
}

const COUNT_UNITS = [
  { size: 1e12, suffix: 'T' },
  { size: 1e9, suffix: 'B' },
  { size: 1e6, suffix: 'M' },
  { size: 1e3, suffix: 'k' },
] as const;

/** 950 → "950", 12_400 → "12.4k", 3_200_000 → "3.2M", 11_400_000_000 → "11.4B". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) < 1000) return String(Math.round(n));
  // A unit takes over once the smaller one would round up to "1000".
  const unit = COUNT_UNITS.find((u) => Math.abs(n) >= u.size * 0.9995) ?? COUNT_UNITS[3];
  return `${trim(n / unit.size)}${unit.suffix}`;
}

const trim = (x: number) =>
  x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, '');
