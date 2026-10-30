import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { selectConnection, useBoard } from '../data/index.js';
import { useMediaQuery, usePreference } from '../prefs.js';
import { cx } from '../ui/cx.js';
import { Hud } from './Hud.js';
import { PhoneShell } from './PhoneShell.js';
import { ProjectRail } from './ProjectRail.js';
import { historyTrack } from './phoneNav.js';
import { NARROW_QUERY, RAIL_ICONS_QUERY, railPreference } from './prefs.js';
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

/** The desktop shell; phones get the phone shell (DESIGN.md §11). */
export function AppShell({ children, sheet, stage, pulse }: AppShellProps) {
  const phone = useMediaQuery(NARROW_QUERY);
  const [location] = useLocation();
  useEffect(() => historyTrack.visit(location), [location]);
  if (phone) return <PhoneShell stage={stage}>{children}</PhoneShell>;
  return (
    <DesktopShell sheet={sheet} stage={stage} pulse={pulse}>
      {children}
    </DesktopShell>
  );
}

/** 768–1023 px keep it with the rail collapsed to icons. */
function DesktopShell({ children, sheet, stage, pulse }: AppShellProps) {
  const narrow = useMediaQuery(RAIL_ICONS_QUERY);
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
        <div
          className={cx(
            'flex shrink-0 transition-opacity duration-base',
            reconnecting && 'opacity-60',
          )}
        >
          <ProjectRail collapsed={collapsed} onToggle={narrow ? undefined : toggleRail} />
        </div>
        <div data-reconnecting={reconnecting || undefined} className="relative flex min-w-0 flex-1">
          {reconnecting && (
            <div
              role="status"
              className="glass pointer-events-none absolute top-3 left-1/2 z-30 flex h-7 -translate-x-1/2 items-center rounded-full border border-line px-3 text-label text-st-err-ink"
            >
              Reconnecting…
            </div>
          )}
          <main
            id="main"
            tabIndex={-1}
            className={cx(
              // Behind the focus view the board is inert, so it has nothing to scroll to.
              'relative min-w-0 flex-1 overflow-y-auto outline-none transition-opacity duration-base has-[[data-offstage]]:overflow-hidden',
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
