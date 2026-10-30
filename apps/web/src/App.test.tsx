// @vitest-environment happy-dom
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { AppRoutes } from './App.js';
import { BoardClient, BoardProvider, type BoardStore, createBoardStore } from './data/index.js';
import { layoutPreference, preloadLayout } from './layouts/registry.js';
import { terminalTarget } from './terminal/target.js';
import { sampleBoard } from './test/board.js';
import { TooltipProvider } from './ui/Tooltip.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Settings and onboarding talk to the server over HTTP; here those requests never settle.
vi.mock('./settings/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settings/api.js')>();
  const pending = () => new Promise<never>(() => {});
  return {
    ...actual,
    api: Object.fromEntries(Object.keys(actual.api).map((key) => [key, pending])),
  };
});

// The focus view's history list loads over HTTP; tests get a fixed listing instead.
vi.mock('./history/api.js', () => ({
  useSessionHistory: (projectId: string) => ({
    state: {
      status: 'ready',
      sessions: [
        {
          id: '9d2e7c41-5a3b-4f6e-8c1d-2b3a4c5d6e7f',
          projectId,
          title: 'Paginate the index',
          firstPrompt: 'paginate the index endpoint',
          cwd: null,
          gitBranch: 'main',
          createdAt: null,
          updatedAt: 1_760_000_000_000,
          fileSize: null,
          tokens: null,
        },
      ],
    },
    retry: () => {},
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  // The overview's layout is a lazy chunk; loaded up front it renders without suspending.
  await Promise.all([
    preloadLayout('minimal'),
    preloadLayout('office'),
    preloadLayout('grid'),
    preloadLayout('transit'),
    preloadLayout('retro'),
  ]);
  // happy-dom's WAAPI rejects Motion's cancelled animations; the pod grid only needs to mount.
  MotionGlobalConfig.skipAnimations = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(path: string, { hydrated = true } = {}) {
  const store: BoardStore = createBoardStore();
  if (hydrated) store.getState().replaceBoard(sampleBoard());
  const client = new BoardClient({ url: 'ws://test.invalid/ws/ui', store });
  const location = memoryLocation({ path, record: true });
  act(() =>
    root.render(
      <BoardProvider client={client} store={store}>
        <TooltipProvider>
          <Router hook={location.hook}>
            <AppRoutes />
          </Router>
        </TooltipProvider>
      </BoardProvider>,
    ),
  );
  return { store, location };
}

const heading = () =>
  (container.querySelector('[data-focus] h1') ?? container.querySelector('main h1'))?.textContent;
const backdrop = () => container.querySelector('main > [data-screen] > div');
const railItems = () =>
  Array.from(
    container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Projects"] [data-rail-item]'),
  );

function press(key: string) {
  const target = document.activeElement ?? document.body;
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('routes', () => {
  it('renders the overview with every project', () => {
    render('/');
    expect(heading()).toBe('Overview');
    const cards = container.querySelectorAll('main a[href="/p/p-acme"], main a[href="/p/p-zen"]');
    expect(cards).toHaveLength(2);
    expect(container.querySelector('main')?.textContent).toContain('Waiting for approval');
  });

  it('draws the overview in the chosen layout, with Minimal as the default', () => {
    render('/');
    expect(
      container.querySelector('main [data-layout="minimal"] [data-pod="p-acme"]'),
    ).not.toBeNull();
    act(() => layoutPreference.set('office'));
    try {
      expect(container.querySelector('main [data-layout="office"] [data-office]')).not.toBeNull();
      act(() => layoutPreference.set('grid'));
      expect(container.querySelector('main [data-layout="grid"] [data-grid]')).not.toBeNull();
      act(() => layoutPreference.set('transit'));
      expect(container.querySelector('main [data-layout="transit"] [data-transit]')).not.toBeNull();
      act(() => layoutPreference.set('retro'));
      const retro = container.querySelector('main [data-layout="retro"]');
      expect(retro?.querySelector('[data-retro] [data-retro-frame="p-acme"]')).not.toBeNull();
      // The console lists the scene: every actor is a button with its number and full name.
      const actor = retro?.querySelector('[data-scene-actor="s:s-1"]');
      expect(actor?.getAttribute('aria-label')).toBe('[1] acme-shop, Claude, waiting for approval');
    } finally {
      act(() => layoutPreference.set('minimal'));
    }
  });

  it('opens a terminal deep link in its project, asking the stack for that tab', () => {
    render('/p/p-acme/t/t-9');
    expect(heading()).toBe('acme-shop');
    expect(terminalTarget.get()).toEqual({ projectId: 'p-acme', terminalId: 't-9' });
    act(() => terminalTarget.set(null));
  });

  it('shows skeletons until the first snapshot', () => {
    render('/', { hydrated: false });
    expect(container.querySelector('main [aria-busy]')).not.toBeNull();
    expect(container.querySelectorAll('main .skeleton').length).toBeGreaterThan(0);
  });

  it('renders the project focus view', () => {
    render('/p/p-orbit');
    expect(heading()).toBe('orbit-api');
    // Without a session in the route the Claude panel shows the project's live one.
    const claude = container.querySelector('[data-focus] section[aria-label="Claude"]');
    // Unnamed, so "Claude", with its first prompt as the subtitle.
    expect(claude?.querySelector('h2')?.textContent).toBe('Claude');
    expect(claude?.querySelector('[data-session-subtitle]')?.textContent).toBe('Rate limiter');
    // The overview stays behind it, inert and hidden from assistive tech.
    expect(backdrop()?.hasAttribute('inert')).toBe(true);
    expect(backdrop()?.getAttribute('aria-hidden')).toBe('true');
    expect(backdrop()?.querySelector('[data-pod="p-orbit"]')).not.toBeNull();
    // The left column lists past sessions with resume actions, and the git panel.
    const row = container.querySelector('[data-focus] [data-history]');
    expect(row?.textContent).toContain('Paginate the index');
    expect(row?.querySelectorAll('button')).toHaveLength(2);
    expect(container.querySelector('[data-focus] [data-git-panel]')?.textContent).toContain(
      'Up to date with origin/main',
    );
  });

  it('lands keyboard focus on the project heading', () => {
    render('/p/p-orbit');
    expect(document.activeElement?.textContent).toBe('orbit-api');
  });

  it('goes back to the overview with Escape', () => {
    const { location } = render('/');
    expect(backdrop()?.hasAttribute('inert')).toBe(false);
    act(() => location.navigate('/p/p-zen'));
    expect(heading()).toBe('zen-notes');
    press('Escape');
    expect(location.history.at(-1)).toBe('/');
    expect(backdrop()?.hasAttribute('inert')).toBe(false);
  });

  it('leaves Escape to text fields and the Attention Center', () => {
    const { location } = render('/p/p-zen');
    const input = document.createElement('input');
    container.append(input);
    act(() => input.focus());
    press('Escape');
    expect(location.history.at(-1)).toBe('/p/p-zen');
    input.remove();
  });

  it('resizes a column from the keyboard and remembers it per project', async () => {
    localStorage.clear();
    render('/p/p-orbit');
    const handle = container.querySelector<HTMLElement>('[role="separator"][data-resize="left"]');
    expect(handle?.getAttribute('aria-valuenow')).toBe('280');
    act(() => handle?.focus());
    press('ArrowRight');
    await vi.waitFor(() => expect(handle?.getAttribute('aria-valuenow')).toBe('296'));
    // Only the resized column is saved; the other keeps following the body width.
    expect(JSON.parse(localStorage.getItem('yardmaster.focus.p-orbit') ?? '{}')).toEqual({
      left: 296,
    });
    expect(localStorage.getItem('yardmaster.focus.p-zen')).toBeNull();
  });

  it('renders a session inside its project', () => {
    render('/p/p-acme/s/s-1');
    expect(heading()).toBe('acme-shop');
    const current = container.querySelector('[data-focus] a[aria-current="page"]');
    expect(current?.getAttribute('href')).toBe('/p/p-acme/s/s-1');
    expect(container.textContent).toContain('Refactoring the cart totals.');
  });

  it('says so when a project is gone', () => {
    render('/p/nope');
    expect(container.textContent).toContain('Project not found');
  });

  it('renders settings and unknown routes', () => {
    render('/settings');
    expect(heading()).toBe('Settings');
    // Layout (5), density (3), theme (3), motion (4), ambient (4), Retro phosphor (6), five notification
    // events (2 each), hide details (2), redact (2), away mode (2), retention (4), terminal reply
    // (2) and the idle window (5). This test browser has no notifications at all.
    expect(container.querySelectorAll('fieldset button[aria-pressed]').length).toBe(52);
    act(() => root.render(null));
    render('/does/not/exist');
    expect(container.textContent).toContain('Nothing here');
  });

  it('marks the current page in the rail', () => {
    render('/p/p-zen');
    const current = railItems().filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['/p/p-zen']);
  });
});

describe('rail keyboard navigation', () => {
  it('has a single tab stop on the current item', () => {
    render('/p/p-orbit');
    const stops = railItems().filter((a) => a.tabIndex === 0);
    expect(stops.map((a) => a.getAttribute('href'))).toEqual(['/p/p-orbit']);
  });

  it('moves focus between items with arrows, Home and End', () => {
    render('/');
    const items = railItems();
    // Overview, Open project (a button), acme-shop, orbit-api, zen-notes, Settings (projects
    // sorted by name).
    expect(items.map((a) => a.getAttribute('href'))).toEqual([
      '/',
      null,
      '/p/p-acme',
      '/p/p-orbit',
      '/p/p-zen',
      '/settings',
    ]);
    act(() => items[0]?.focus());
    press('ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    press('j');
    expect(document.activeElement).toBe(items[2]);
    press('ArrowUp');
    expect(document.activeElement).toBe(items[1]);
    press('End');
    expect(document.activeElement).toBe(items[5]);
    press('ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    press('Home');
    expect(document.activeElement).toBe(items[0]);
  });

  it('navigates when a rail item is activated', () => {
    const { location } = render('/');
    const zen = railItems().find((a) => a.getAttribute('href') === '/p/p-zen');
    act(() => zen?.click());
    expect(location.history.at(-1)).toBe('/p/p-zen');
    expect(heading()).toBe('zen-notes');
  });
});
