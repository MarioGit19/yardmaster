import type { ClaudeSession, SessionStatus, Terminal } from '@c-board/protocol';

/** Semantic status tones, DESIGN.md §2. Each maps to a `--st-*` token. */
export type Tone = 'work' | 'tool' | 'wait' | 'ok' | 'err' | 'idle';

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
      return { tone: 'err', label: 'Error' };
    case 'compacting':
      return { tone: 'work', label: 'Compacting' };
    case 'unknown':
      return { tone: 'idle', label: status.alive ? 'Running' : 'Unknown' };
    case 'ended':
      return { tone: 'idle', label: 'Ended' };
  }
}

const RANK: Record<Tone, number> = { wait: 4, err: 3, tool: 2, work: 2, ok: 1, idle: 0 };

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
  work: 'Working',
  tool: 'Tool active',
  wait: 'Needs you',
  ok: 'Done',
  err: 'Error',
  idle: 'Idle',
};

export const toneLabel = (tone: Tone) => TONE_LABEL[tone];

export function totalTokens(session: Pick<ClaudeSession, 'tokens'>): number {
  const { input, output, cacheRead, cacheCreation } = session.tokens;
  return input + output + cacheRead + cacheCreation;
}

/** 950 → "950", 12_400 → "12.4k", 3_200_000 → "3.2M". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_950) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

const trim = (x: number) =>
  x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, '');
