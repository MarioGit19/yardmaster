import { transcriptStreamId } from '@yardmaster/protocol';
import { useEffect, useState } from 'react';
import { useBoardClient } from '../data/index.js';
import { TranscriptModel, type TranscriptRow } from './transcript.js';

/** How long an empty stream counts as loading before it shows as empty. */
const EMPTY_AFTER_MS = 600;

export interface TranscriptView {
  rows: readonly TranscriptRow[];
  /** False until the first chunks arrive (or the stream turns out to be empty). */
  loaded: boolean;
}

/**
 * The `transcript:<sessionId>` stream as display rows. Chunks are batched per frame, so a
 * replay of hundreds of messages becomes one render. Nothing is subscribed until `enabled`.
 */
export function useTranscript(sessionId: string, enabled = true): TranscriptView {
  const client = useBoardClient();
  const [view, setView] = useState<TranscriptView & { sessionId: string }>({
    sessionId,
    rows: [],
    loaded: false,
  });

  useEffect(() => {
    if (!enabled) return;
    const model = new TranscriptModel();
    let pending: string[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const chunks = pending;
      pending = [];
      const changed = model.pushChunks(chunks);
      setView((v) =>
        changed || !v.loaded || v.sessionId !== sessionId
          ? { sessionId, rows: model.rows, loaded: true }
          : v,
      );
    };
    const unsubscribe = client.subscribeStream(transcriptStreamId(sessionId), (chunk) => {
      pending.push(chunk);
      frame ||= requestAnimationFrame(flush);
    });
    const empty = setTimeout(() => {
      if (!frame) flush();
    }, EMPTY_AFTER_MS);
    return () => {
      unsubscribe();
      clearTimeout(empty);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [client, sessionId, enabled]);

  return view.sessionId === sessionId ? view : { rows: [], loaded: false };
}
