// @vitest-environment happy-dom
import type { BoardSettings } from '@c-board/protocol';
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardClient,
  BoardProvider,
  type BoardStore,
  createBoardStore,
} from '../data/index.js';
import { boardSettings } from '../settings/boardSettings.js';
import { makeProject, makeSession, sampleBoard } from '../test/board.js';
import { TooltipProvider } from '../ui/Tooltip.js';
import { PodGrid } from './PodGrid.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // happy-dom's WAAPI rejects Motion's cancelled animations; pods only need to mount.
  MotionGlobalConfig.skipAnimations = true;
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

let serverSettings: BoardSettings;

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined);
  // The pods read the server settings (pins, the idle window).
  serverSettings = {
    retentionDays: 7,
    awayMode: false,
    awayTimeoutSec: 120,
    terminalReply: true,
    libraryRoots: [],
    libraryIdleHideMin: 30,
    pinnedProjects: [],
  };
  vi.stubGlobal('fetch', async () => Response.json(serverSettings));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const client = {
  subscribeStream: () => () => {},
} as unknown as BoardClient;

function render(store: BoardStore) {
  act(() =>
    root.render(
      <BoardProvider client={client} store={store}>
        <TooltipProvider>
          <PodGrid />
        </TooltipProvider>
      </BoardProvider>,
    ),
  );
}

function sampleStore() {
  const store = createBoardStore();
  store.getState().replaceBoard(sampleBoard());
  return store;
}

const HOUR = 60 * 60_000;

const podIds = () =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-pod]'), (el) => el.dataset.pod);
const pod = (id: string) => container.querySelector<HTMLElement>(`[data-pod="${id}"]`);

describe('PodGrid', () => {
  it('lists projects attention first', () => {
    render(sampleStore());
    expect(podIds()).toEqual(['p-acme', 'p-zen', 'p-orbit']);
  });

  it('reorders when a project stops waiting', () => {
    const store = sampleStore();
    render(store);
    act(() => {
      const board = store.getState().board;
      const s1 = board.sessions['s-1'];
      if (!s1) throw new Error('missing session');
      store.getState().replaceBoard({
        ...board,
        sessions: { ...board.sessions, 's-1': { ...s1, status: { kind: 'idle' } } },
      });
    });
    expect(podIds()).toEqual(['p-zen', 'p-acme', 'p-orbit']);
  });

  it('leaves out quiet projects unless they are pinned (F26)', async () => {
    const store = sampleStore();
    const board = store.getState().board;
    const quiet = { ...makeProject('p-quiet', 'quiet-lab'), lastActivityAt: Date.now() - HOUR };
    store.getState().replaceBoard({ ...board, projects: { ...board.projects, 'p-quiet': quiet } });
    render(store);
    expect(podIds()).toEqual(['p-acme', 'p-zen', 'p-orbit']);

    await act(() => boardSettings.load()); // the request the grid made on mount
    serverSettings = { ...serverSettings, pinnedProjects: ['p-quiet'] };
    await act(() => boardSettings.load());
    expect(podIds()).toContain('p-quiet');
  });
});

describe('ProjectPod', () => {
  it('takes the most urgent status for its border, crew and session row', () => {
    render(sampleStore());
    const acme = pod('p-acme');
    expect(acme?.dataset.tone).toBe('wait');
    expect(acme?.className).toContain('glow-st-wait');
    expect(acme?.querySelector('header [data-crew]')?.getAttribute('data-crew')).toBe('waiting');
    const row = acme?.querySelector('[data-session="s-1"]');
    expect(row?.textContent).toContain('Waiting for approval');
    expect(row?.textContent).toContain('12.4k tok');
    expect(row?.textContent).toContain('Refactoring the cart totals.');
    // The row's own crew member (24 px, the orb as its antenna) raises its hand too.
    expect(row?.querySelector('[data-crew]')?.getAttribute('data-crew')).toBe('waiting');
    expect(row?.querySelector('[data-crew] [data-orb]')?.getAttribute('data-orb')).toBe('waiting');

    expect(pod('p-zen')?.dataset.tone).toBe('err');
    expect(pod('p-orbit')?.dataset.tone).toBe('work');
    expect(pod('p-orbit')?.querySelector('[data-shimmer]')).not.toBeNull();
  });

  it('shows one crew member for a project without sessions', () => {
    render(sampleStore());
    const zen = pod('p-zen');
    expect(zen?.querySelectorAll('header [data-crew]')).toHaveLength(1);
    expect(zen?.textContent).toContain('No Claude sessions');
  });

  it('shows git state: branch, changed files, ahead and behind', () => {
    const store = createBoardStore();
    const project = makeProject('p1', 'acme-shop');
    if (project.git)
      Object.assign(project.git, { branch: 'feat/cart', dirty: 3, ahead: 1, behind: 2 });
    store.getState().replaceBoard({
      ...store.getState().board,
      projects: { p1: project },
      sessions: { s1: makeSession('s1', 'p1', { kind: 'idle' }) },
    });
    render(store);
    const header = pod('p1')?.querySelector('header');
    expect(header?.textContent).toContain('feat/cart');
    expect(header?.textContent).toContain('3 changed');
    expect(header?.textContent).toContain('1 ahead');
    expect(header?.textContent).toContain('2 behind');
  });

  it('caps the header crew and the session rows at three', () => {
    const store = createBoardStore();
    const sessions = Object.fromEntries(
      [1, 2, 3, 4, 5].map((n) => [`s${n}`, makeSession(`s${n}`, 'p1', { kind: 'working' })]),
    );
    store.getState().replaceBoard({
      ...store.getState().board,
      projects: { p1: makeProject('p1', 'acme-shop') },
      sessions,
    });
    render(store);
    const p1 = pod('p1');
    expect(p1?.querySelectorAll('header [data-crew]')).toHaveLength(3);
    expect(p1?.querySelectorAll('[data-session]')).toHaveLength(3);
    expect(p1?.textContent).toContain('2 more sessions');
  });

  it("shows the running tool's chip in the session row", () => {
    const store = createBoardStore();
    store.getState().replaceBoard({
      ...store.getState().board,
      projects: { p1: makeProject('p1', 'acme-shop') },
      sessions: { s1: makeSession('s1', 'p1', { kind: 'tool', tool: 'Grep', toolUseId: 't1' }) },
    });
    render(store);
    const row = pod('p1')?.querySelector('[data-session="s1"]');
    expect(row?.querySelector('[data-crew]')?.getAttribute('data-crew')).toBe('reading');
    // Hidden below a 360 px row by a container query; present in the DOM either way.
    expect(row?.querySelector('[data-tool-chip]')?.textContent).toBe('Grep');
  });

  it('plays "done" once a turn finishes', () => {
    const store = createBoardStore();
    store.getState().replaceBoard({
      ...store.getState().board,
      projects: { p1: makeProject('p1', 'acme-shop') },
      sessions: { s1: { ...makeSession('s1', 'p1', { kind: 'working' }), updatedAt: Date.now() } },
    });
    render(store);
    const crew = () => pod('p1')?.querySelector('header [data-crew]')?.getAttribute('data-crew');
    expect(crew()).toBe('thinking');
    const finish = () => {
      const board = store.getState().board;
      const s1 = board.sessions.s1;
      if (!s1) throw new Error('missing session');
      store.getState().replaceBoard({
        ...board,
        sessions: { s1: { ...s1, status: { kind: 'idle' }, updatedAt: Date.now() } },
      });
    };
    act(finish);
    expect(crew()).toBe('done');
    // A re-render right after doesn't cut it short.
    act(finish);
    expect(crew()).toBe('done');
  });
});
