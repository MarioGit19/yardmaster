import { toolFamily } from '@yardmaster/protocol';
import { createPreference } from '../prefs.js';
import type { TranscriptRow } from './transcript.js';

export const VERBOSITIES = ['summary', 'normal', 'verbose'] as const;
export type Verbosity = (typeof VERBOSITIES)[number];

/** How much of a transcript the chat shows, per device. */
export const verbosityPreference = createPreference(
  'yardmaster.chat.verbosity',
  VERBOSITIES,
  'normal',
);

/**
 * Whether Summary keeps a row: what was said and what came of it. A tool call only counts as a
 * result when it failed, changed a file or ran a subagent.
 */
function isOutcome(row: TranscriptRow): boolean {
  if (row.kind === 'thinking') return false;
  if (row.kind !== 'tool') return true;
  if (row.result?.isError) return true;
  const family = toolFamily(row.name);
  return family === 'edit' || family === 'task';
}

/** The rows a level shows, in order. Normal and Verbose show them all. */
export function shownRows(rows: readonly TranscriptRow[], level: Verbosity) {
  return level === 'summary' ? rows.filter(isOutcome) : rows;
}

/** The first row at or after `id` that `shown` still has, so a level switch keeps the reader's place. */
export function nearestShown(
  rows: readonly TranscriptRow[],
  shown: readonly TranscriptRow[],
  id: string,
): string | null {
  const ids = new Set(shown.map((row) => row.id));
  const from = rows.findIndex((row) => row.id === id);
  if (from < 0) return null;
  for (let i = from; i < rows.length; i++) {
    const row = rows[i] as TranscriptRow;
    if (ids.has(row.id)) return row.id;
  }
  return shown[shown.length - 1]?.id ?? null;
}
