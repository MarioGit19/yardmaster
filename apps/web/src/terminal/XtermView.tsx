import '@xterm/xterm/css/xterm.css';
import type { StreamId } from '@c-board/protocol';
import { FitAddon } from '@xterm/addon-fit';
import { type ISearchOptions, SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { useBoardClient } from '../data/index.js';
import { domColorResolver, xtermTheme } from './theme.js';

/** What the stack's toolbar can do to a mounted terminal. */
export interface XtermController {
  find(query: string, direction: 'next' | 'previous'): void;
  clearSearch(): void;
  /** Clears the view only; the terminal itself and the server buffer are untouched. */
  clear(): void;
  focus(): void;
  /** Match position after each search; returns the unsubscribe. */
  onSearchResults(listener: (results: { index: number; count: number }) => void): () => void;
}

export interface XtermViewProps {
  terminalId: string;
  label: string;
  onController?: (controller: XtermController | null) => void;
}

const FONT_FAMILY = '"Geist Mono Variable", ui-monospace, "SF Mono", Menlo, monospace';
const FONT_SIZE = 12;
const SCROLLBACK = 10_000;
const GAP_NOTE = '\r\n\x1b[2m… earlier output was dropped …\x1b[22m\r\n';

/**
 * One mirrored terminal (PRD F2): xterm 6 with the WebGL renderer (DOM fallback), fit and
 * search, themed from the tokens. Output comes from `term:<id>`, replayed from the client's
 * stream history, so a pane can be disposed and remounted without losing what it showed.
 */
export default function XtermView({ terminalId, label, onController }: XtermViewProps) {
  const client = useBoardClient();
  const hostRef = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<'webgl' | 'dom' | null>(null);
  const onControllerRef = useRef(onController);
  onControllerRef.current = onController;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const cleanups: (() => void)[] = [];

    const colors = domColorResolver(host);
    cleanups.push(colors.dispose);
    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: 1.25,
      scrollback: SCROLLBACK,
      // A mirror: input goes through the stack's command line, not raw keystrokes.
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
      theme: xtermTheme(colors.resolve),
    });
    cleanups.push(() => term.dispose());
    const fit = new FitAddon();
    const search = new SearchAddon({ highlightLimit: 500 });
    term.loadAddon(fit);
    term.loadAddon(search);

    const decorations = (): ISearchOptions['decorations'] => ({
      matchBackground: colors.resolve('color-mix(in srgb, var(--st-wait) 25%, transparent)'),
      activeMatchBackground: colors.resolve('color-mix(in srgb, var(--st-wait) 55%, transparent)'),
      matchOverviewRuler: colors.resolve('var(--st-wait)'),
      activeMatchColorOverviewRuler: colors.resolve('var(--st-wait)'),
    });
    const resultListeners = new Set<(results: { index: number; count: number }) => void>();
    const results = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      for (const listener of resultListeners) listener({ index: resultIndex, count: resultCount });
    });
    cleanups.push(() => results.dispose());

    const refit = () => {
      if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // Not measurable yet (e.g. hidden); the next resize fits it.
      }
    };

    const start = () => {
      if (disposed) return;
      term.open(host);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          // Lost GPU context: drop to the DOM renderer for the rest of this pane's life.
          webgl.dispose();
          setRenderer('dom');
        });
        term.loadAddon(webgl);
        setRenderer('webgl');
      } catch {
        setRenderer('dom');
      }
      refit();

      const unsubscribe = client.subscribeStream(
        `term:${terminalId}` as StreamId,
        (chunk, info) => {
          if (info.gap) term.write(GAP_NOTE);
          term.write(chunk);
        },
      );
      cleanups.push(unsubscribe);

      let frame = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(refit);
      });
      ro.observe(host);
      cleanups.push(() => {
        cancelAnimationFrame(frame);
        ro.disconnect();
      });

      // The light/dark switch only flips an attribute on <html>; re-read the tokens then.
      const mo = new MutationObserver(() => {
        term.options.theme = xtermTheme(colors.resolve);
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      cleanups.push(() => mo.disconnect());

      onControllerRef.current?.({
        find: (query, direction) => {
          const options = { incremental: direction === 'next', decorations: decorations() };
          if (direction === 'next') search.findNext(query, options);
          else search.findPrevious(query, options);
        },
        clearSearch: () => search.clearDecorations(),
        clear: () => term.clear(),
        focus: () => term.focus(),
        onSearchResults: (listener) => {
          resultListeners.add(listener);
          return () => resultListeners.delete(listener);
        },
      });
    };

    // xterm measures its cell size on open, so wait for the mono face first.
    const fonts = document.fonts;
    if (fonts?.load) {
      fonts.load(`${FONT_SIZE}px ${FONT_FAMILY}`).then(start, start);
    } else start();

    return () => {
      disposed = true;
      onControllerRef.current?.(null);
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  }, [client, terminalId]);

  return (
    <div
      ref={hostRef}
      role="log"
      aria-label={label}
      data-xterm={terminalId}
      data-renderer={renderer ?? undefined}
      className="xterm-host h-full min-h-0 w-full"
    />
  );
}
