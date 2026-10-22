import { type ReactNode, useEffect } from 'react';
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
  /** Bottom rail slot (Pulse). */
  pulse?: ReactNode;
}

export function AppShell({ children, sheet, pulse }: AppShellProps) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const rail = usePreference(railPreference);
  const collapsed = narrow || rail === 'collapsed';
  const toggleRail = () => railPreference.set(rail === 'collapsed' ? 'expanded' : 'collapsed');
  const reconnecting = useBoard(selectConnection).status === 'reconnecting';

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
      {reconnecting && (
        <div
          role="status"
          className="flex h-8 shrink-0 items-center justify-center border-line border-b bg-bg-1 text-label text-st-err"
        >
          Reconnecting…
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <ProjectRail collapsed={collapsed} onToggle={narrow ? undefined : toggleRail} />
        <main
          id="main"
          tabIndex={-1}
          className={cx(
            'min-w-0 flex-1 overflow-y-auto outline-none transition-opacity duration-200',
            reconnecting && 'opacity-60',
          )}
        >
          {children}
        </main>
        {sheet}
      </div>
      {pulse}
    </div>
  );
}
