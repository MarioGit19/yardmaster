// @vitest-environment happy-dom
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { AppRoutes } from '../App.js';
import { BoardClient, BoardProvider, type BoardStore, createBoardStore } from '../data/index.js';
import { sampleBoard } from '../test/board.js';
import { TooltipProvider } from '../ui/Tooltip.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The focus view's history list loads over HTTP; there is no server here.
vi.mock('../history/api.js', () => ({
  useSessionHistory: () => ({ state: { status: 'ready', sessions: [] }, retry: () => {} }),
}));

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
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

function render(path = '/') {
  const store: BoardStore = createBoardStore();
  store.getState().replaceBoard(sampleBoard());
  store.getState().setConnection({ status: 'live' });
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

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

const counter = (label: string) =>
  container.querySelector(`[data-counter="${label}"] [data-value]`)?.getAttribute('data-value');

describe('Failed', () => {
  it('stops counting a terminal once it has been opened', async () => {
    const { store } = render();
    expect(counter('Failed')).toBe('1');
    act(() => root.unmount());
    root = createRoot(container);
    const client = new BoardClient({ url: 'ws://test.invalid/ws/ui', store });
    const location = memoryLocation({ path: '/p/p-zen/t/t-1' });
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
    await settle();
    expect(counter('Failed')).toBe('0');
  });
});
