import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { type ISearchOptions, SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { StreamId } from '@yardmaster/protocol';
import { useEffect, useRef, useState } from 'react';
import { RESIZE_END, resizingAncestor } from '../anim/resizing.js';
import { useBoardClient } from '../data/index.js';
import { useSkinId } from '../focus/skins/registry.js';
import { StreamRedactor } from '../redact/redact.js';
import { releasesFocus } from './focusKeys.js';
import { ctrlLatch } from './keyBar.js';
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
  /** Mask secrets in the output (PRD §8.7). Changing it remounts the view and replays. */
  redact?: boolean;
  onController?: (controller: XtermController | null) => void;
  /** `dom` keeps the page's one WebGL context free, e.g. under the Grid's 3D network. */
  prefer?: 'webgl' | 'dom';
  /**
   * A board terminal (F19): keystrokes go straight to its pty and the pty follows this view's
   * size, so TUIs work. Otherwise the view is a read-only mirror.
   */
  input?: boolean;
}

const FONT_FAMILY = '"Geist Mono Variable", ui-monospace, "SF Mono", Menlo, monospace';
const FONT_SIZE = 12;
const SCROLLBACK = 10_000;
/** Longest an unfinished line is held back while it's checked for secrets. */
const REDACT_HOLD_MS = 40;
const GAP_NOTE = '\r\n\x1b[2m… earlier output was dropped …\x1b[22m\r\n';

/**
 * One mirrored terminal (PRD F2): xterm 6 with the WebGL renderer (DOM fallback), fit and
 * search, themed from the tokens. Output comes from `term:<id>`, replayed from the client's
 * stream history, so a pane can be disposed and remounted without losing what it showed.
 */
export default function XtermView({
  terminalId,
  label,
  redact = false,
  onController,
  prefer = 'webgl',
  input = false,
}: XtermViewProps) {
  const client = useBoardClient();
  const hostRef = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<'webgl' | 'dom' | null>(null);
  const onControllerRef = useRef(onController);
  onControllerRef.current = onController;
  // The workspace skin's colors (DESIGN.md §10.8); a skin switch re-themes the open terminal.
  const skin = useSkinId();
  const skinRef = useRef(skin);
  skinRef.current = skin;
  const rethemeRef = useRef<(() => void) | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new skin is the reason to re-theme.
  useEffect(() => {
    rethemeRef.current?.();
  }, [skin]);

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
      // A mirror takes input through the stack's command line; a board terminal takes keystrokes.
      disableStdin: !input,
      cursorBlink: false,
      cursorInactiveStyle: input ? 'outline' : 'none',
      allowProposedApi: true,
      theme: xtermTheme(colors.resolve, skinRef.current),
    });
    const retheme = () => {
      term.options.theme = xtermTheme(colors.resolve, skinRef.current);
    };
    rethemeRef.current = retheme;
    cleanups.push(() => {
      rethemeRef.current = null;
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
      term.attachCustomKeyEventHandler((event) => !releasesFocus(event, input));
      term.textarea?.setAttribute(
        'aria-description',
        input ? 'Tab completes in the shell. Shift+Tab leaves the terminal.' : 'Read only.',
      );
      if (prefer === 'dom') setRenderer('dom');
      else
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

      if (input) {
        const keys = term.onData((data) =>
          client.terminalInput(terminalId, ctrlLatch.apply(terminalId, data)),
        );
        const sized = term.onResize(({ cols, rows }) =>
          client.terminalResize(terminalId, cols, rows),
        );
        client.terminalResize(terminalId, term.cols, term.rows);
        cleanups.push(() => {
          keys.dispose();
          sized.dispose();
        });
      }

      // The write filter: masked output goes in, the raw text never reaches the terminal.
      const redactor = redact ? new StreamRedactor() : null;
      let hold: ReturnType<typeof setTimeout> | null = null;
      const write = (chunk: string) => {
        if (!redactor) {
          term.write(chunk);
          return;
        }
        const ready = redactor.push(chunk);
        if (ready) term.write(ready);
        if (redactor.pending) {
          hold ??= setTimeout(() => {
            hold = null;
            term.write(redactor.flush());
          }, REDACT_HOLD_MS);
        }
      };
      const unsubscribe = client.subscribeStream(
        `term:${terminalId}` as StreamId,
        (chunk, info) => {
          if (info.gap) {
            if (redactor) term.write(redactor.flush());
            term.write(GAP_NOTE);
          }
          write(chunk);
        },
      );
      cleanups.push(() => {
        unsubscribe();
        if (hold) clearTimeout(hold);
      });

      // A fit re-measures and reflows the whole buffer: while a column drag or spring runs, skip
      // the per-frame fits and fit once when it lands.
      let frame = 0;
      let waiting: Element | null = null;
      const scheduleRefit = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(settledRefit);
      };
      const onResizeEnd = () => {
        waiting = null;
        scheduleRefit();
      };
      const settledRefit = () => {
        const resizing = resizingAncestor(host);
        if (!resizing) return refit();
        if (waiting === resizing) return;
        waiting?.removeEventListener(RESIZE_END, onResizeEnd);
        waiting = resizing;
        resizing.addEventListener(RESIZE_END, onResizeEnd, { once: true });
      };
      const ro = new ResizeObserver(scheduleRefit);
      ro.observe(host);
      cleanups.push(() => {
        cancelAnimationFrame(frame);
        ro.disconnect();
        waiting?.removeEventListener(RESIZE_END, onResizeEnd);
      });

      // The light/dark switch only flips an attribute on <html>; re-read the tokens then.
      const mo = new MutationObserver(retheme);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      // So does Retro's phosphor (green or amber) on the workspace.
      const workspace = host.closest('.focus');
      if (workspace)
        mo.observe(workspace, { attributes: true, attributeFilter: ['data-phosphor'] });
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
  }, [client, terminalId, redact, prefer, input]);

  return (
    <div
      ref={hostRef}
      role="log"
      aria-label={label}
      data-xterm={terminalId}
      data-input={input || undefined}
      data-renderer={renderer ?? undefined}
      className="xterm-host h-full min-h-0 w-full"
    />
  );
}
