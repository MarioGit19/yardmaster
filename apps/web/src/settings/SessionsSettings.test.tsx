// @vitest-environment happy-dom
import type { BrowserSession } from '@yardmaster/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.js';
import { SessionsRow } from './SessionsSettings.js';

const phone = vi.hoisted(() => ({ on: false }));
vi.mock('./remoteHost.js', () => ({ onRemoteHost: () => phone.on }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = (id: string, kind: BrowserSession['kind'], current = false): BrowserSession => ({
  id,
  kind,
  name: kind === 'remote' ? 'iPhone · Safari' : 'Mac · Firefox',
  createdAt: 1,
  lastSeenAt: 2,
  current,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.spyOn(api, 'sessions').mockResolvedValue({
    sessions: [session('mac-1', 'local'), session('phone-1', 'remote', true)],
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  phone.on = false;
});

const signOutButtons = () =>
  [...container.querySelectorAll('li[data-session]')].map((li) => [
    li.getAttribute('data-session'),
    li.querySelector('button') !== null,
  ]);

describe('SessionsRow', () => {
  it('signs out any browser from the Mac', async () => {
    await act(async () => root.render(<SessionsRow />));
    expect(signOutButtons()).toEqual([
      ['mac-1', true],
      ['phone-1', true],
    ]);
  });

  it('lets a phone sign out only itself', async () => {
    phone.on = true;
    await act(async () => root.render(<SessionsRow />));
    expect(signOutButtons()).toEqual([
      ['mac-1', false],
      ['phone-1', true],
    ]);
  });
});
