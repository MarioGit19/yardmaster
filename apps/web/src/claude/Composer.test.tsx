// @vitest-environment happy-dom
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { type BoardClient, BoardProvider, createBoardStore } from '../data/index.js';
import { draftKey, drafts } from '../drafts/drafts.js';
import { TooltipProvider } from '../ui/Tooltip.js';
import { NewSessionComposer } from './Composer.js';

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
