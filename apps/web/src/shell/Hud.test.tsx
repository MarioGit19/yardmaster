// @vitest-environment happy-dom
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { AppRoutes } from '../App.js';
import { attentionOpen } from '../attention/attention.js';
import { BoardClient, BoardProvider, type BoardStore, createBoardStore } from '../data/index.js';
import { motionPreference } from '../motion.js';
import { makeSession, sampleBoard } from '../test/board.js';
import { TooltipProvider } from '../ui/Tooltip.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  attentionOpen.set('closed');
  motionPreference.set('system');
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
const waitingButton = () => container.querySelector<HTMLButtonElement>('[data-hud="waiting"]');
const sheet = () => container.querySelector('aside[aria-labelledby="attention-title"]');

describe('Hud', () => {
  it('shows live counters that follow the store', () => {
    const { store } = render();
    expect(counter('Working')).toBe('1');
    expect(counter('Waiting')).toBe('1');
    expect(counter('Errors')).toBe('1');
    expect(counter('Running')).toBe('0');
    act(() => {
      const board = structuredClone(store.getState().board);
      board.sessions['s-3'] = makeSession('s-3', 'p-zen', { kind: 'waiting_input' });
      store.getState().replaceBoard(board);
    });
    expect(counter('Waiting')).toBe('2');
  });

  it('opens the Attention Center from the Waiting count and closes it with Escape', async () => {
    const { location } = render();
    expect(sheet()).toBeNull();
    act(() => {
      waitingButton()?.focus();
      waitingButton()?.click();
    });
    expect(waitingButton()?.getAttribute('aria-expanded')).toBe('true');
    expect(sheet()?.textContent).toContain('acme-shop');
    expect(sheet()?.textContent).toContain('Checkout fix');
    expect(document.activeElement?.id).toBe('attention-title');

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(waitingButton());

    act(() => waitingButton()?.click());
    act(() => sheet()?.querySelector<HTMLAnchorElement>('a[href="/p/p-acme/s/s-1"]')?.click());
    await settle();
    expect(location.history?.at(-1)).toBe('/p/p-acme/s/s-1');
    expect(sheet()).toBeNull();
  });

  it('shows the reconnect state', () => {
    const { store } = render();
    const status = () => container.querySelector('[data-connection]');
    expect(status()?.getAttribute('data-connection')).toBe('live');
    expect(status()?.textContent).toContain('Live');
    act(() => store.getState().setConnection({ status: 'reconnecting', attempt: 1 }));
    expect(status()?.textContent).toContain('Reconnecting…');
    expect(status()?.querySelector('.hud-spin')).not.toBeNull();
  });

  it('cycles the motion level', () => {
    render();
    const toggle = () => container.querySelector<HTMLButtonElement>('[data-hud="motion"]');
    expect(toggle()?.getAttribute('aria-label')).toBe('Motion: System (switch to Full)');
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      act(() => toggle()?.click());
      seen.push(motionPreference.get());
    }
    expect(seen).toEqual(['full', 'reduced', 'off', 'system']);
  });
});
