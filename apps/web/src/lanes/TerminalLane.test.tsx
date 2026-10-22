// @vitest-environment happy-dom
import type { Execution, PortBinding } from '@c-board/protocol';
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardClient,
  BoardProvider,
  type BoardStore,
  type ChunkListener,
  createBoardStore,
} from '../data/index.js';
import { makeProject, makeTerminal } from '../test/board.js';
import { TooltipProvider } from '../ui/Tooltip.js';
import { TerminalLane } from './TerminalLane.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // happy-dom's WAAPI rejects Motion's cancelled animations; the lane only needs to mount.
  MotionGlobalConfig.skipAnimations = true;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const NOW = Date.now();

function execution(over: Partial<Execution> = {}): Execution {
  return {
    id: 'e1',
    terminalId: 't1',
    commandLine: 'pnpm dev',
    confidence: 'high',
    cwd: null,
    startedAt: NOW - 125_000,
    endedAt: null,
    exitCode: null,
    outputBytes: 0,
    truncated: false,
    interactive: false,
    ...over,
  };
}

const port: PortBinding = {
  id: '127.0.0.1:3000',
  port: 3000,
  address: '127.0.0.1',
  pid: 4242,
  command: 'node',
  terminalId: 't1',
  projectId: 'p1',
  firstSeenAt: NOW,
};

/** A client stand-in that hands stream listeners to the test. */
function fakeClient() {
  const streams = new Map<string, ChunkListener>();
  const client = {
    subscribeStream(id: string, listener: ChunkListener) {
      streams.set(id, listener);
      return () => streams.delete(id);
    },
  } as unknown as BoardClient;
  return { client, streams };
}

function render(exec: Execution | null, ports: PortBinding[] = []) {
  const store: BoardStore = createBoardStore();
  const board = store.getState().board;
  const terminal = { ...makeTerminal('t1', 'p1'), name: 'backend' };
  if (exec) terminal.executionIds = [exec.id];
  store.getState().replaceBoard({
    ...board,
    projects: { p1: makeProject('p1', 'acme-shop') },
    terminals: { t1: terminal },
    executions: exec ? { [exec.id]: exec } : {},
    ports: Object.fromEntries(ports.map((p) => [p.id, p])),
  });
  const { client, streams } = fakeClient();
  act(() =>
    root.render(
      <BoardProvider client={client} store={store}>
        <TooltipProvider>
          <ul>
            <TerminalLane terminal={terminal} accent="var(--accent-2)" />
          </ul>
        </TooltipProvider>
      </BoardProvider>,
    ),
  );
  return { store, streams };
}

const lane = () => container.querySelector<HTMLLIElement>('[data-lane="t1"]');
const toggle = () => container.querySelector<HTMLButtonElement>('[aria-expanded]');

describe('TerminalLane', () => {
  it('renders name, command, port and uptime in their columns', () => {
    render(execution(), [port]);
    const row = lane()?.querySelector('.lane-row');
    expect(row?.children).toHaveLength(4);
    expect(toggle()?.textContent).toContain('backend');
    expect(toggle()?.textContent).toContain('pnpm dev');
    expect(container.querySelector('[data-sparkline]')).not.toBeNull();
    expect(container.querySelector('[data-port="3000"]')?.textContent).toBe(':3000');
    expect(row?.lastElementChild?.textContent).toBe('2m');
  });

  it('shows the exit badge once the command ends', () => {
    const { store } = render(execution());
    act(() =>
      store
        .getState()
        .applyOps([
          { op: 'merge', path: ['executions', 'e1'], value: { endedAt: NOW, exitCode: 1 } },
        ]),
    );
    expect(container.querySelector('[aria-label="Exit code 1"]')?.textContent).toBe('1');
  });

  it('does not re-render on output bytes alone', () => {
    const { store } = render(execution());
    const before = toggle();
    act(() =>
      store
        .getState()
        .applyOps([{ op: 'merge', path: ['executions', 'e1'], value: { outputBytes: 9_000 } }]),
    );
    expect(toggle()).toBe(before);
  });

  it('marks the lane as streaming once output arrives', () => {
    const { store } = render(execution());
    expect(lane()?.dataset.streaming).toBeUndefined();
    act(() => {
      store
        .getState()
        .applyOps([{ op: 'merge', path: ['executions', 'e1'], value: { outputBytes: 4_096 } }]);
      vi.advanceTimersByTime(1_000);
    });
    expect(lane()?.dataset.streaming).toBe('true');
    act(() => vi.advanceTimersByTime(2_000));
    expect(lane()?.dataset.streaming).toBeUndefined();
  });

  it('pins a live peek of the last six lines, throttled', () => {
    const { streams } = render(execution());
    expect(streams.size).toBe(0);
    act(() => toggle()?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    const listener = streams.get('term:t1');
    expect(listener).toBeDefined();

    const info = { seq: 0, replay: false } as unknown as Parameters<ChunkListener>[1];
    act(() => {
      listener?.(Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\r\n'), info);
    });
    const peek = () => container.querySelector('[data-peek="t1"]');
    expect(peek()?.textContent).toBe('No recent output');
    act(() => vi.advanceTimersByTime(100));
    const lines = Array.from(peek()?.querySelectorAll('p') ?? [], (p) => p.textContent);
    expect(lines).toEqual(['line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8']);

    act(() => toggle()?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on hover after a short delay', () => {
    render(execution());
    const enter = new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' });
    act(() => {
      lane()?.dispatchEvent(enter);
    });
    act(() => vi.advanceTimersByTime(200));
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      lane()?.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }),
      );
    });
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('copies localhost:port from the port chip', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(execution(), [port]);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-port]')?.click());
    expect(writeText).toHaveBeenCalledWith('localhost:3000');
  });
});
