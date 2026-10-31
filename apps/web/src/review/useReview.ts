import {
  GitReview,
  type PullRequestBadge,
  PullRequestResponse,
  REVIEW_ERRORS,
} from '@yardmaster/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { boardFetch } from '../auth/session.js';
import type { ViewedMarks } from './model.js';

/** Long enough to see a worktree the scanner doesn't watch change, short of hammering git. */
const POLL_MS = 5_000;

export type ReviewState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; review: GitReview };

const reviewUrl = (projectId: string, worktree: string | undefined, leaf = '') => {
  const query = worktree ? `?worktree=${encodeURIComponent(worktree)}` : '';
  return `/api/projects/${encodeURIComponent(projectId)}/review${leaf}${query}`;
};

async function fetchReview(
  projectId: string,
  worktree: string | undefined,
): Promise<ReviewState & { status: 'ready' | 'error' }> {
  try {
    const res = await boardFetch(reviewUrl(projectId, worktree));
    const body: unknown = await res.json();
    if (!res.ok) {
      const error = (body as { error?: unknown } | null)?.error;
      return { status: 'error', error: typeof error === 'string' ? error : REVIEW_ERRORS.failed };
    }
    const parsed = GitReview.safeParse(body);
    return parsed.success
      ? { status: 'ready', review: parsed.data }
      : { status: 'error', error: REVIEW_ERRORS.failed };
  } catch {
    return { status: 'error', error: REVIEW_ERRORS.failed };
  }
}

/**
 * The review on screen stays put while the files move: a newer one waits in `newer`, so the diff
 * the user commits is the diff they read. `reload` takes the latest at once.
 */
export function useReview(projectId: string, worktree: string | undefined) {
  const [state, setState] = useState<ReviewState>({ status: 'loading' });
  const [newer, setNewer] = useState<GitReview | null>(null);
  const shown = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const next = await fetchReview(projectId, worktree);
    shown.current = next.status === 'ready' ? next.review.revision : null;
    setNewer(null);
    setState(next);
  }, [projectId, worktree]);

  useEffect(() => {
    setState({ status: 'loading' });
    void reload();
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      const next = await fetchReview(projectId, worktree);
      if (next.status !== 'ready') return;
      if (next.review.revision !== shown.current) setNewer(next.review);
      else setNewer(null);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [projectId, worktree, reload]);

  const showNewer = useCallback(() => {
    if (!newer) return;
    shown.current = newer.revision;
    setState({ status: 'ready', review: newer });
    setNewer(null);
  }, [newer]);

  return { state, stale: newer !== null, showNewer, reload };
}

/** The branch's pull request, if the machine's `gh` can tell. Quietly nothing otherwise. */
export function usePullRequest(projectId: string, worktree: string | undefined) {
  const [pr, setPr] = useState<PullRequestBadge | null>(null);
  useEffect(() => {
    let live = true;
    setPr(null);
    boardFetch(reviewUrl(projectId, worktree, '/pr'))
      .then((res) => res.json())
      .then((body: unknown) => {
        const parsed = PullRequestResponse.safeParse(body);
        if (live && parsed.success) setPr(parsed.data.pr);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, worktree]);
  return pr;
}

const VIEWED_KEY = 'yardmaster.review.viewed';
/** Folders remembered; the oldest go first. */
const MAX_TARGETS = 40;

type ViewedByTarget = Record<string, ViewedMarks>;

function loadViewed(): ViewedByTarget {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(VIEWED_KEY) ?? '{}');
    return typeof value === 'object' && value !== null ? (value as ViewedByTarget) : {};
  } catch {
    return {};
  }
}

/** "Viewed" marks for one review target, kept on this device. */
export function useViewed(target: string) {
  const [marks, setMarks] = useState<ViewedMarks>(() => loadViewed()[target] ?? {});
  useEffect(() => setMarks(loadViewed()[target] ?? {}), [target]);
  const update = useCallback(
    (next: ViewedMarks) => {
      setMarks(next);
      const { [target]: _old, ...others } = loadViewed();
      const kept = Object.entries(others).slice(-(MAX_TARGETS - 1));
      try {
        localStorage.setItem(
          VIEWED_KEY,
          JSON.stringify({ ...Object.fromEntries(kept), [target]: next }),
        );
      } catch {
        // Private mode: the marks last as long as the page.
      }
    },
    [target],
  );
  return [marks, update] as const;
}
