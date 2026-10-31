import { redact, type SearchRun, type SearchStatus } from '@yardmaster/protocol';
import { create } from 'zustand';
import type { TranscriptRow } from '../claude/transcript.js';

export const SEARCH_DATES = ['any', '7', '30', '90'] as const;
export type SearchDate = (typeof SEARCH_DATES)[number];

export const SEARCH_DATE_LABEL: Record<SearchDate, string> = {
  any: 'Any time',
  '7': '7 days',
  '30': '30 days',
  '90': '90 days',
};

export const SEARCH_STATUS_LABEL: Record<SearchStatus, string> = {
  all: 'All',
  live: 'Live',
  finished: 'Finished',
  archived: 'Archived',
};

/** Search stays as it was left: opening a result and coming back keeps the list. */
export interface SearchDraft {
  query: string;
  projectId: string;
  date: SearchDate;
  status: SearchStatus;
}

const draft = create<SearchDraft>(() => ({ query: '', projectId: '', date: 'any', status: 'all' }));

export const searchDraft = {
  use: draft,
  get: () => draft.getState(),
  set: (patch: Partial<SearchDraft>) => draft.setState(patch),
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The filters as a query string, or null with nothing to search for. */
export function searchParams(
  { query, projectId, date, status }: SearchDraft,
  limit: number,
  now: number,
): URLSearchParams | null {
  const q = query.trim();
  if (q === '') return null;
  const params = new URLSearchParams({ q, status, limit: String(limit) });
  if (projectId) params.set('projectId', projectId);
  if (date !== 'any') params.set('from', String(now - Number(date) * DAY_MS));
  return params;
}

/**
 * A snippet with secrets masked when redaction is on. Masking runs over the whole text, so a
 * secret split across runs is caught; what remains marked keeps its place only when no mask
 * changed the text.
 */
export function maskedSnippet(runs: readonly SearchRun[], on: boolean): SearchRun[] {
  if (!on) return [...runs];
  const text = runs.map((run) => run.text).join('');
  const masked = redact(text);
  return masked === text ? [...runs] : [{ text: masked, hit: false }];
}

/** The row a message shows in: a tool's result sits in the row of its call. */
export function rowForMessage(
  rows: readonly TranscriptRow[],
  messages: readonly { id: string; kind: string; toolUseId?: string }[],
  messageId: string | undefined,
): string | null {
  if (!messageId) return null;
  if (rows.some((row) => row.id === messageId)) return messageId;
  const message = messages.find((m) => m.id === messageId);
  if (!message?.toolUseId) return null;
  const tool = rows.find((row) => row.kind === 'tool' && row.toolUseId === message.toolUseId);
  return tool?.id ?? null;
}
