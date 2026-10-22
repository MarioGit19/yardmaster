import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { selectConnection, useBoard } from '../data/index.js';
import { useMediaQuery, usePreference } from '../prefs.js';
import { cx } from '../ui/cx.js';
import { Hud } from './Hud.js';
import { ProjectRail } from './ProjectRail.js';
import { NARROW_QUERY, railPreference } from './prefs.js';
import { isTypingTarget } from './railNav.js';

export interface AppShellProps {
  children: ReactNode;
  /** Right sheet slot (Attention Center, settings sheet). */
  sheet?: ReactNode;
  /** A layer over the main area (the focus view), outside its scroll. */
  stage?: ReactNode;
  /** Bottom rail slot (Pulse). */
  pulse?: ReactNode;
}

export function AppShell({ children, sheet, stage, pulse }: AppShellProps) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const rail = usePreference(railPreference);
  const collapsed = narrow || rail === 'collapsed';
  const toggleRail = () => railPreference.set(rail === 'collapsed' ? 'expanded' : 'collapsed');
  const reconnecting = useBoard(selectConnection).status === 'reconnecting';
  const pulseRef = usePulseHeight();

  useEffect(() => {
    if (narrow) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '[' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      railPreference.set(railPreference.get() === 'collapsed' ? 'expanded' : 'collapsed');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <button
        type="button"
        onClick={() => document.getElementById('main')?.focus()}
        className="fixed top-2 left-2 z-50 -translate-y-16 rounded-control bg-bg-2 px-3 py-1.5 text-body-sm focus:translate-y-0"
      >
        Skip to content
      </button>
      <Hud />
      <div className="relative flex min-h-0 flex-1">
        {reconnecting && (
          <div
            role="status"
            className="glass pointer-events-none absolute inset-x-0 top-0 z-30 flex h-8 items-center justify-center border-line border-b text-label text-st-err-ink"
          >
            Reconnecting…
          </div>
        )}
        <div
          className={cx(
            'flex shrink-0 transition-opacity duration-base',
            reconnecting && 'opacity-60',
          )}
        >
          <ProjectRail collapsed={collapsed} onToggle={narrow ? undefined : toggleRail} />
        </div>
        <div data-reconnecting={reconnecting || undefined} className="relative flex min-w-0 flex-1">
          <main
            id="main"
            tabIndex={-1}
            className={cx(
              'min-w-0 flex-1 overflow-y-auto outline-none transition-opacity duration-base',
              reconnecting && 'opacity-60',
            )}
          >
            {children}
          </main>
          {stage}
        </div>
        {sheet}
      </div>
      {pulse && (
        <div
          ref={pulseRef}
          className={cx('shrink-0 transition-opacity duration-base', reconnecting && 'opacity-60')}
        >
          {pulse}
        </div>
      )}
    </div>
  );
}

/** Publishes the Pulse rail's height as `--pulse-h`, so toasts can sit above it. */
function usePulseHeight() {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback((el: HTMLDivElement | null) => {
    const root = document.documentElement.style;
    observer.current?.disconnect();
    observer.current = null;
    if (!el) {
      root.removeProperty('--pulse-h');
      return;
    }
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(() =>
      root.setProperty('--pulse-h', `${el.offsetHeight}px`),
    );
    observer.current.observe(el);
  }, []);
}
