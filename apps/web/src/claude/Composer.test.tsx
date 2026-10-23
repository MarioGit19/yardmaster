// @vitest-environment happy-dom
import type { ClaudeSession } from '@c-board/protocol';
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { type BoardClient, BoardProvider, createBoardStore } from '../data/index.js';
import { draftKey, drafts } from '../drafts/drafts.js';
import { makeSession } from '../test/board.js';
import { TooltipProvider } from '../ui/Tooltip.js';
import { NewSessionComposer, SessionComposer } from './Composer.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = 'p-acme';
const KEY = draftKey.newSession(PROJECT);

let container: HTMLDivElement;
let root: Root;
const action = vi.fn();

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  action.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  drafts.clear(KEY);
});

function render() {
  const client = { action } as unknown as BoardClient;
  act(() =>
    root.render(
      <BoardProvider client={client} store={createBoardStore()}>
        <TooltipProvider>
          <Router hook={memoryLocation({ path: '/' }).hook}>
            <NewSessionComposer projectId={PROJECT} />
          </Router>
        </TooltipProvider>
      </BoardProvider>,
    ),
  );
}

const input = () => {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('no composer');
  return el;
};

function type(text: string) {
  const el = input();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container.querySelector('form')?.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('composer drafts', () => {
  it('saves what is typed and restores it, caret at the end, when it mounts again', () => {
    render();
    type('Plan the cart refactor');
    expect(drafts.get(KEY)).toBe('Plan the cart refactor');
    act(() => root.unmount());
    root = createRoot(container);
    render();
    expect(input().value).toBe('Plan the cart refactor');
    expect(input().selectionStart).toBe('Plan the cart refactor'.length);
  });

  it('keeps the draft when the send fails', async () => {
    action.mockResolvedValue({ ok: false, error: 'unknown_project' });
    render();
    type('Still here');
    await submit();
    expect(action).toHaveBeenCalledOnce();
    expect(input().value).toBe('Still here');
    expect(drafts.get(KEY)).toBe('Still here');
  });

  it('clears the draft once sent', async () => {
    action.mockResolvedValue({ ok: true });
    render();
    type('Ship it');
    await submit();
    expect(action).toHaveBeenCalledOnce();
    expect(input().value).toBe('');
    expect(drafts.get(KEY)).toBe('');
  });
});

describe('session dock', () => {
  // The terminal composer reads the reply setting from the server; it stays loading here.
  beforeEach(() =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    ),
  );
  afterEach(() => vi.unstubAllGlobals());

  function renderSession(session: ClaudeSession) {
    const client = { action } as unknown as BoardClient;
    act(() =>
      root.render(
        <BoardProvider client={client} store={createBoardStore()}>
          <TooltipProvider>
            <Router hook={memoryLocation({ path: '/' }).hook}>
              <SessionComposer session={session} />
            </Router>
          </TooltipProvider>
        </BoardProvider>,
      ),
    );
  }

  const button = (name: string) => {
    const found = [...container.querySelectorAll('button')].find((b) => b.textContent === name);
    if (!found) throw new Error(`no ${name} button`);
    return found;
  };

  it('offers Resume for a board session a restart interrupted, and resumes the same id', async () => {
    action.mockResolvedValue({ ok: true, sessionId: 's-1' });
    renderSession({
      ...makeSession('s-1', PROJECT, { kind: 'interrupted', turnRunning: true }),
      origin: 'board',
    });
    expect(container.querySelector('[data-resume-bar]')?.textContent).toContain(
      'Interrupted by a board restart',
    );
    expect(container.querySelector('form')).toBeNull();
    await act(async () => button('Resume').click());
    expect(action).toHaveBeenCalledWith({
      kind: 'session.resume',
      sessionId: 's-1',
      projectId: PROJECT,
    });
  });

  it('continues a terminal session whose Claude exited in the board, without a fork', async () => {
    action.mockResolvedValue({ ok: true, sessionId: 's-2' });
    renderSession(makeSession('s-2', PROJECT, { kind: 'ended' }));
    expect(container.querySelector('[data-fork-bar]')).toBeNull();
    await act(async () => button('Continue in board').click());
    expect(action).toHaveBeenCalledWith({
      kind: 'session.resume',
      sessionId: 's-2',
      projectId: PROJECT,
    });
  });

  it('forks a session still running in a terminal the board cannot type into', () => {
    renderSession(makeSession('s-3', PROJECT, { kind: 'idle' }));
    expect(container.querySelector('[data-fork-bar]')?.textContent).toContain(
      'Running in a terminal',
    );
    expect(button('Fork into the board')).toBeTruthy();
  });
});
