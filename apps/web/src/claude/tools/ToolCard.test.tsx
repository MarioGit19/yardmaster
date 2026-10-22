// @vitest-environment happy-dom
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_CWD, TOOL_SAMPLES } from '../../dev/toolSamples.js';
import type { ToolRow } from '../transcript.js';
import { diffLayoutPreference } from './DiffView.js';
import { ToolCard } from './ToolCard.js';
import { ToolViewState } from './viewState.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  MotionGlobalConfig.skipAnimations = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  diffLayoutPreference.set('unified');
  MotionGlobalConfig.skipAnimations = false;
});

const sample = (label: string): ToolRow => {
  const found = TOOL_SAMPLES.find((s) => s.label === label);
  if (!found) throw new Error(label);
  return found.row;
};

const render = (row: ToolRow) =>
  act(() =>
    root.render(
      <ToolViewState>
        <ToolCard key={row.id} row={row} cwd={SAMPLE_CWD} />
      </ToolViewState>,
    ),
  );
const $ = (selector: string) => container.querySelector(selector);
const click = (el: Element | null) => act(() => (el as HTMLElement).click());

describe('ToolCard', () => {
  it('picks a variant for every sample', () => {
    const kinds = TOOL_SAMPLES.map(({ row }) => {
      render(row);
      return $('[data-tool-kind]')?.getAttribute('data-tool-kind');
    });
    expect(new Set(kinds)).toEqual(
      new Set([
        'bash',
        'edit',
        'write',
        'read',
        'grep',
        'glob',
        'todo',
        'task',
        'fetch',
        'search',
        'other',
      ]),
    );
  });

  it('Bash: exit status, and the output opens on failure', () => {
    render(sample('Bash'));
    expect($('[data-exit]')?.getAttribute('data-exit')).toBe('0');
    expect($('pre')).toBeNull();
    click($('button[aria-expanded]'));
    expect($('pre')?.textContent).toContain('21 passed');

    render(sample('Bash, failed'));
    expect($('[data-exit]')?.getAttribute('data-exit')).toBe('1');
    expect($('pre')?.textContent).toContain('AssertionError');
    expect($('pre')?.textContent).not.toContain('Exit code');

    render(sample('Bash, running'));
    expect($('[data-state]')?.getAttribute('data-state')).toBe('running');
    expect(container.textContent).toContain('background');
  });

  it('Edit: a numbered diff with stats and a unified/split toggle', () => {
    render(sample('Edit'));
    expect(container.textContent).toContain('src/cart/discount.ts');
    expect(container.textContent).toContain('+3');
    expect(container.textContent).toContain('−1');
    const added = container.querySelectorAll('[data-diff="add"]');
    expect(added).toHaveLength(3);
    expect(added[0]?.textContent).toContain('42');
    expect($('[data-diff="add"] .diff-mark')).not.toBeNull();

    click(container.querySelector('[role="radio"][aria-checked="false"]'));
    expect(diffLayoutPreference.get()).toBe('split');
    expect($('[data-diff-view]')?.getAttribute('data-diff-view')).toBe('split');
    expect(container.querySelectorAll('.diff-empty').length).toBeGreaterThan(0);
  });

  it('MultiEdit and Write', () => {
    render(sample('MultiEdit'));
    expect(container.textContent).toContain('2 edits');
    expect(container.textContent).toContain('Edit 2');
    render(sample('Write'));
    expect(container.textContent).toContain('New file');
    expect(container.querySelectorAll('[data-diff="del"]')).toHaveLength(0);
  });

  it('Read, Grep and Glob are chips that open a preview', () => {
    render(sample('Read'));
    expect($('[data-tool-kind="read"] .tool-chip')).not.toBeNull();
    expect(container.textContent).toContain('5 lines');
    click($('button[aria-expanded]'));
    expect(container.textContent).toContain('const ordered');

    render(sample('Grep'));
    expect(container.textContent).toContain('3 files');
    render(sample('Glob'));
    expect(container.textContent).toContain('2 files');
  });

  it('WebFetch and WebSearch show URL chips', () => {
    render(sample('WebFetch'));
    expect(container.textContent).toContain('docs.example.org');
    expect($('a[target="_blank"]')?.getAttribute('rel')).toContain('noopener');
    render(sample('WebSearch'));
    expect(container.textContent).toContain('2 links');
    click($('button[aria-expanded]'));
    expect(container.querySelectorAll('a[href^="https://"]')).toHaveLength(2);
  });

  it('TodoWrite: a checklist with progress', () => {
    render(sample('TodoWrite'));
    expect(container.querySelectorAll('[data-todo="completed"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-todo="in_progress"]')).toHaveLength(1);
    expect(container.textContent).toContain('2/4');
  });

  it('Task: a collapsed subagent thread', () => {
    render(sample('Task'));
    expect(container.textContent).toContain('Explore');
    expect($('.task-thread')).toBeNull();
    click($('button[aria-expanded]'));
    expect($('.task-thread')?.textContent).toContain('src/checkout/summary.ts:28');
  });

  it('unknown tools show their input as JSON', () => {
    render(sample('Unknown tool'));
    expect(container.textContent).toContain('tracker · create_ticket');
    click($('button[aria-expanded]'));
    expect(container.textContent).toContain('"priority": "medium"');
    expect(container.textContent).toContain('TRK-142');
  });

  it('glitches a failure that happens on screen, not one scrolled back into view', () => {
    const task = sample('Task');
    const running = { ...task, result: null };
    const failed = { ...task, result: { text: 'Agent crashed', isError: true } };
    render(running);
    expect($('.tool-running')).not.toBeNull();
    render(failed);
    expect($('[data-tool-kind]')?.classList.contains('tool-glitch')).toBe(true);
    act(() =>
      root.render(
        <ToolViewState key="remount">
          <ToolCard row={failed} />
        </ToolViewState>,
      ),
    );
    expect($('[data-tool-kind]')?.classList.contains('tool-glitch')).toBe(false);
  });

  it('pops the check when a running chip finishes', () => {
    const read = sample('Read');
    render({ ...read, result: null });
    expect($('[data-done]')).toBeNull();
    render(read);
    expect($('[data-done]')).not.toBeNull();
    expect($('.tool-glitch')).toBeNull();
  });

  it('keeps a card open across remounts', () => {
    const row = sample('Task');
    const view = (show: boolean) =>
      act(() =>
        root.render(
          <ToolViewState>{show && <ToolCard row={row} cwd={SAMPLE_CWD} />}</ToolViewState>,
        ),
      );
    view(true);
    click($('button[aria-expanded]'));
    view(false);
    view(true);
    expect($('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('falls back to the generic card for malformed input', () => {
    render({ ...sample('Edit'), input: { file_path: 42 } });
    expect($('[data-tool-kind]')?.getAttribute('data-tool-kind')).toBe('other');
  });
});
