// @vitest-environment happy-dom
import type { GitInfo } from '@yardmaster/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitPanel } from './GitPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = 1_760_000_000_000;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const git = (patch: Partial<GitInfo> = {}): GitInfo => ({
  branch: 'main',
  head: null,
  detached: false,
  dirty: 0,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  commits: [],
  updatedAt: T0,
  ...patch,
});

describe('GitPanel', () => {
  it('says why a repository whose config runs commands has no status', () => {
    act(() => root.render(<GitPanel git={git({ branch: null, statusSkipped: true })} now={T0} />));
    expect(container.querySelector('[data-git-skipped]')?.textContent).toBe(
      'git status skipped: repository config runs commands',
    );
    expect(container.textContent).not.toContain('Working tree clean');
  });

  it('shows the status otherwise', () => {
    act(() => root.render(<GitPanel git={git()} now={T0} />));
    expect(container.querySelector('[data-git-skipped]')).toBeNull();
    expect(container.textContent).toContain('Working tree clean');
  });
});
