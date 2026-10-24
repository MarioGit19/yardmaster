import { useEffect } from 'react';
import { type BoardStoreState, useBoard } from '../data/index.js';
import { applyFavicon, faviconState, waitingCount } from './favicon.js';

const selectFaviconState = (s: BoardStoreState) => faviconState(s.board);
const selectWaitingCount = (s: BoardStoreState) => waitingCount(s.board);

/** Keeps the tab's favicon and `(n) Yardmaster` title in step with the board. */
export function LiveFavicon() {
  const state = useBoard(selectFaviconState);
  const waiting = useBoard(selectWaitingCount);
  useEffect(() => applyFavicon(document, state, waiting), [state, waiting]);
  return null;
}
