import type { BoardState } from '@c-board/protocol';
import { projectTone, sessionStatusView } from '../status.js';
import logoSource from './logo.svg?raw';
import { BRAND_NAME } from './name.js';
import { FAVICON_COLORS, renderLogo, svgDataUrl } from './render.js';

/** What the tab shows: calm, something waiting on you, or something crashed. */
export type FaviconState = 'idle' | 'wait' | 'err';

const TITLE = BRAND_NAME;

export function waitingCount(board: BoardState): number {
  let count = 0;
  for (const session of Object.values(board.sessions)) {
    if (sessionStatusView(session.status).tone === 'wait') count++;
  }
  return count;
}

/** Waiting wins over errors, matching the project tone ranking. */
export function faviconState(board: BoardState): FaviconState {
  const tone = projectTone(Object.values(board.sessions), Object.values(board.terminals));
  return tone === 'wait' || tone === 'err' ? tone : 'idle';
}

export function faviconHref(state: FaviconState): string {
  return svgDataUrl(renderLogo(logoSource, FAVICON_COLORS[state]));
}

export function documentTitle(waiting: number): string {
  return waiting > 0 ? `(${waiting}) ${TITLE}` : TITLE;
}

/** Points the SVG `<link rel=icon>` (created on first use) at the icon for `state`. */
export function applyFavicon(doc: Document, state: FaviconState, waiting: number): void {
  let link = doc.querySelector<HTMLLinkElement>('link#live-favicon');
  if (!link) {
    link = doc.createElement('link');
    link.id = 'live-favicon';
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    doc.head.append(link);
  }
  link.dataset.state = state;
  link.href = faviconHref(state);
  doc.title = documentTitle(waiting);
}
