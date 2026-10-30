import { Activity, Bell, Ellipsis, FolderKanban, LayoutGrid, Search } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { attentionOpen } from '../attention/attention.js';
import { Logomark } from '../brand/Logo.js';
import { selectConnection, selectHydrated, useBoard } from '../data/index.js';
import { dur, ease, spring, tabGlide } from '../motion.js';
import { paletteOpen } from '../palette/palette.js';
import { countOf, plural } from '../plural.js';
import { routes } from '../routes.js';
import { cx } from '../ui/cx.js';
import { Tooltip } from '../ui/Tooltip.js';
import { hudSeverity } from './counts.js';
import { Counter } from './Hud.js';
import {
  COUNTER_BUTTON,
  COUNTER_HINT,
  JumpCounter,
  SEVERITY_RING,
  useHudCounts,
} from './HudCounters.js';
import { isWorkspace, PHONE_TAB_HREF, PHONE_TABS, type PhoneTab, phoneTabFor } from './phoneNav.js';

const TAB_ICON = {
  overview: LayoutGrid,
  projects: FolderKanban,
  attention: Bell,
  pulse: Activity,
  more: Ellipsis,
} as const;

const TAB_LABEL: Record<PhoneTab, string> = {
  overview: 'Overview',
  projects: 'Projects',
  attention: 'Attention',
  pulse: 'Pulse',
  more: 'More',
};

/**
 * The phone shell, DESIGN.md §11: a 48 px top bar, the main area, and the bottom tab bar in place
 * of the project rail and the Pulse rail. A workspace (the focus view) takes the whole screen
 * with its own app bar; both bars leave while it is open.
 */
export function PhoneShell({ children, stage }: { children: ReactNode; stage?: ReactNode }) {
  const [location, navigate] = useLocation();
  const workspace = isWorkspace(location);
  const reconnecting = useBoard(selectConnection).status === 'reconnecting';
  const hydrated = useBoard(selectHydrated);
  useVisualViewport();
  useToastLift(workspace);

  // The Attention Center is the Attention tab here: whatever asks for the sheet (⌘K, an approval
  // toast) opens the tab instead.
  useEffect(() => {
    const open = () => {
      if (attentionOpen.get() !== 'open') return;
      attentionOpen.set('closed');
      navigate(routes.attention);
    };
    open();
    return attentionOpen.subscribe(open);
  }, [navigate]);

  return (
    <div
      className="phone-shell fixed inset-x-0 flex flex-col overflow-hidden"
      data-phone-shell=""
      data-hydrated={hydrated || undefined}
    >
      <button
        type="button"
        onClick={() => document.getElementById('main')?.focus()}
        className="fixed top-2 left-2 z-50 -translate-y-16 rounded-control bg-bg-2 px-3 py-1.5 text-body-sm focus:translate-y-0"
      >
        Skip to content
      </button>
      {!workspace && <PhoneTopBar />}
      <div className="relative flex min-h-0 flex-1">
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
            // Under a workspace the page is covered and its content inert: no Tab stop, no scroll.
            inert={workspace || undefined}
            className={cx(
              'relative min-w-0 flex-1 overflow-y-auto overscroll-contain outline-none transition-opacity duration-base',
              // The tab bar floats over the bottom of the page; the last row scrolls clear of it.
              'pb-[var(--tabbar-h)]',
              reconnecting && 'opacity-60',
            )}
          >
            {children}
          </main>
          {stage}
        </div>
        <AnimatePresence initial={false}>
          {!workspace && <TabBar key="tabs" location={location} />}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Logomark, the three counts (Needs you opens the Attention tab) and search (⌘K). */
function PhoneTopBar() {
  const counts = useHudCounts();
  const severity = hudSeverity(counts);
  const stale = useBoard(selectConnection).status === 'reconnecting';
  const armed = useBoard(selectHydrated);
  return (
    <header
      data-phone-topbar=""
      className="flex shrink-0 items-center gap-1 border-line border-b bg-bg-1 px-1 pt-[env(safe-area-inset-top)]"
      style={{ height: 'calc(48px + env(safe-area-inset-top))' }}
    >
      <Link
        href={routes.overview}
        aria-label="Yardmaster overview"
        className="grid size-11 shrink-0 place-items-center rounded-control text-text-1"
      >
        <Logomark className="size-6" />
      </Link>
      <ul
        aria-label="Activity"
        data-severity={severity ?? undefined}
        className={cx(
          'mx-auto flex min-w-0 items-center gap-2 rounded-control transition-opacity duration-base',
          severity && SEVERITY_RING[severity],
          stale && 'opacity-60',
        )}
      >
        <li>
          <Tooltip content={COUNTER_HINT.needsYou}>
            <Link
              href={routes.attention}
              data-hud="needs-you"
              aria-label={`${countOf(counts.needsYou, 'needs', 'need')} you, open the Attention Center`}
              className={cx(COUNTER_BUTTON, 'h-11')}
            >
              <Counter
                tone="wait"
                label="Needs you"
                value={counts.needsYou}
                flare="ripple"
                armed={armed}
              />
            </Link>
          </Tooltip>
        </li>
        <li>
          <JumpCounter bucket="failed" label="Failed" value={counts.failed}>
            <Counter tone="err" label="Failed" value={counts.failed} flare="flash" armed={armed} />
          </JumpCounter>
        </li>
        <li>
          <JumpCounter bucket="active" label="Active" value={counts.active}>
            <Counter tone="work" label="Active" value={counts.active} />
          </JumpCounter>
        </li>
      </ul>
      <button
        type="button"
        aria-label="Search"
        aria-haspopup="dialog"
        onClick={() => paletteOpen.set('open')}
        className="grid size-11 shrink-0 place-items-center rounded-control text-text-2 transition-[background-color,color,scale] duration-fast ease-out hover:bg-bg-2 hover:text-text-1 moving:active:scale-[0.97]"
      >
        <Search aria-hidden className="size-5" strokeWidth={1.5} />
      </button>
    </header>
  );
}

/**
 * The bottom tab bar, in thumb reach: glass, 56 px plus the home-indicator inset. The active
 * tab's pill glides to the next one (`tabGlide`: snaps when picked from the keyboard). It slides
 * away under an opening workspace and back up when the workspace closes.
 */
function TabBar({ location }: { location: string }) {
  const active = phoneTabFor(location);
  const waiting = useHudCounts().needsYou;
  const [byKeyboard, setByKeyboard] = useState(false);
  return (
    <motion.nav
      aria-label="Main"
      data-tab-bar=""
      initial={{ y: '100%' }}
      animate={{ y: 0, transition: spring.smooth }}
      exit={{ y: '100%', transition: { duration: dur.fast, ease: ease.out } }}
      className="palette absolute inset-x-0 bottom-0 z-[5] border-line border-t pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="flex h-14 items-stretch px-1">
        {PHONE_TABS.map((tab) => {
          const Icon = TAB_ICON[tab];
          const selected = tab === active;
          return (
            <li key={tab} className="flex min-w-0 flex-1">
              <Link
                href={PHONE_TAB_HREF[tab]}
                aria-current={selected ? 'page' : undefined}
                data-tab={tab}
                onClick={(e) => setByKeyboard(e.detail === 0)}
                className={cx(
                  'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-control text-label transition-colors duration-fast',
                  selected ? 'text-text-1' : 'text-text-2',
                )}
              >
                <span className="relative grid h-7 w-14 place-items-center">
                  {selected && (
                    <motion.span
                      layoutId="phone-tab-indicator"
                      transition={tabGlide(byKeyboard)}
                      aria-hidden
                      data-tab-indicator=""
                      className="absolute inset-0 rounded-full bg-bg-2 shadow-raised"
                    />
                  )}
                  <Icon aria-hidden className="relative size-5" strokeWidth={1.5} />
                  {tab === 'attention' && waiting > 0 && (
                    <span
                      data-tab-badge=""
                      className="tabular absolute top-0 right-2 grid h-4 min-w-4 place-items-center rounded-full bg-st-wait px-1 font-medium text-label text-bg-0 leading-none"
                    >
                      {waiting > 99 ? '99+' : waiting}
                      <span className="sr-only"> {plural(waiting, 'needs', 'need')} you</span>
                    </span>
                  )}
                </span>
                <span className="max-w-full truncate">{TAB_LABEL[tab]}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </motion.nav>
  );
}

/**
 * Keeps the shell inside the visual viewport. Where the on-screen keyboard resizes the page
 * (`interactive-widget=resizes-content`, Android) this matches `100dvh`; where it only covers
 * it (iOS), the shell shrinks and follows the viewport's offset, and sheets lift by the keyboard
 * (`--kb-inset`), so the composer and its Send stay in view while typing. Pinch zoom is left
 * alone.
 */
function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement.style;
    const update = () => {
      if (Math.abs(viewport.scale - 1) > 0.01) return;
      root.setProperty('--app-h', `${Math.round(viewport.height)}px`);
      root.setProperty('--app-top', `${Math.round(viewport.offsetTop)}px`);
      const inset = window.innerHeight - viewport.height - viewport.offsetTop;
      root.setProperty('--kb-inset', `${Math.max(0, Math.round(inset))}px`);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      for (const name of ['--app-h', '--app-top', '--kb-inset']) root.removeProperty(name);
    };
  }, []);
}

/**
 * Toasts sit above the tab bar, or above the composer in a workspace (`--composer-h`, published
 * by the composers), never over either.
 */
function useToastLift(workspace: boolean) {
  const apply = useCallback(() => {
    document.documentElement.style.setProperty(
      '--pulse-h',
      workspace ? 'var(--composer-h, 0px)' : 'var(--tabbar-h)',
    );
  }, [workspace]);
  useEffect(() => {
    apply();
    return () => {
      document.documentElement.style.removeProperty('--pulse-h');
    };
  }, [apply]);
}
