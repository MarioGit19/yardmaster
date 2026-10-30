/** Who a transcript row speaks for: the user, Claude (its text, thinking and tool calls), or none. */
export type Speaker = 'you' | 'claude';

interface TurnItem {
  kind: string;
  ts?: number | null;
}

const speakerOf = (item: TurnItem | undefined): Speaker | null =>
  !item || item.kind === 'fork' || item.kind === 'rest'
    ? null
    : item.kind === 'user'
      ? 'you'
      : 'claude';

const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface TurnHead {
  speaker: Speaker;
  /** `YOU · 14:02`, or just `CLAUDE` for a reply still being written. */
  label: string;
}

/**
 * The header of the turn that opens at `index`: the first row after the other speaker, the start
 * of the list or the fork divider. Null inside a turn. Retro draws it as `── YOU · 14:02 ──`.
 */
export function turnHead(
  items: readonly TurnItem[],
  index: number,
  format: (ts: number) => string = (ts) => clock.format(ts),
): TurnHead | null {
  const item = items[index];
  const speaker = speakerOf(item);
  if (!item || speaker === null || speakerOf(items[index - 1]) === speaker) return null;
  const name = speaker === 'you' ? 'YOU' : 'CLAUDE';
  const ts = item.ts ?? null;
  return { speaker, label: ts === null ? name : `${name} · ${format(ts)}` };
}
