// @vitest-environment happy-dom
import type { PortSharesResponse } from '@yardmaster/protocol';
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../settings/api.js';
import { TooltipProvider } from '../ui/Tooltip.js';
import { PortButton } from './PortButton.js';
import { portShareRequest, portShares } from './shares.js';

const phone = vi.hoisted(() => ({ on: false }));
vi.mock('../settings/remoteHost.js', () => ({ onRemoteHost: () => phone.on }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST = 'dev-box.tailnet-test.ts.net';
const ready = (shares: PortSharesResponse['shares'] = []): PortSharesResponse => ({
  available: true,
  reason: null,
  host: HOST,
  shares,
});
const shared = { port: 3000, url: `https://${HOST}:3000`, mine: true, sharedAt: 1, hint: null };

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});

beforeEach(() => {
  vi.spyOn(api, 'portShares').mockReturnValue(new Promise(() => {}));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  portShares.set(null);
  portShareRequest.set(null);
  phone.on = false;
  vi.restoreAllMocks();
});

function render() {
  act(() =>
    root.render(
      <TooltipProvider>
        <PortButton port={3000}>:3000</PortButton>
      </TooltipProvider>,
    ),
  );
  return container.querySelector<HTMLButtonElement>('[data-port="3000"]');
}

describe('PortButton', () => {
  it('copies localhost:port without Tailscale', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    portShares.set({ available: false, reason: 'not_installed', host: null, shares: [] });
    const button = render();
    expect(button?.getAttribute('aria-label')).toBe('Copy localhost:3000');
    await act(async () => button?.click());
    expect(writeText).toHaveBeenCalledWith('localhost:3000');
    expect(document.querySelector('[data-port-menu]')).toBeNull();
  });

  it('offers Open on phone on the Mac when Tailscale is ready', async () => {
    portShares.set(ready());
    const button = render();
    await act(async () => button?.click());
    const menu = document.querySelector('[data-port-menu="3000"]');
    expect(menu?.textContent).toContain('Copy localhost:3000');
    const open = menu?.querySelector<HTMLButtonElement>('[data-open-on-phone="3000"]');
    expect(open?.textContent).toBe('Open on phone…');
    await act(async () => open?.click());
    expect(portShareRequest.get()).toBe(3000);
  });

  it('marks a shared port and offers to stop sharing it', async () => {
    portShares.set(ready([shared]));
    const button = render();
    expect(button?.hasAttribute('data-port-shared')).toBe(true);
    expect(button?.querySelector('[data-on-phone]')).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toBe(':3000, on phone');
    const unshare = vi.spyOn(api, 'unsharePort').mockResolvedValue({ ok: true });
    await act(async () => button?.click());
    const stop = [...document.querySelectorAll('[data-port-menu] button')].find(
      (b) => b.textContent === 'Stop sharing',
    ) as HTMLButtonElement | undefined;
    await act(async () => stop?.click());
    expect(unshare).toHaveBeenCalledWith(3000);
    expect(portShares.get()?.shares).toEqual([]);
    expect(button?.hasAttribute('data-port-shared')).toBe(false);
  });

  it('opens the tailnet URL directly on the phone, sharing it first', async () => {
    phone.on = true;
    portShares.set(ready());
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const share = vi.spyOn(api, 'sharePort').mockResolvedValue(shared);
    const button = render();
    expect(button?.getAttribute('aria-label')).toBe('Open :3000 on this phone');
    await act(async () => button?.click());
    expect(share).toHaveBeenCalledWith(3000);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.location.href).toBe(shared.url);
    expect(tab.opener).toBeNull();
    expect(button?.hasAttribute('data-port-shared')).toBe(true);

    // Already shared: straight to it.
    await act(async () => button?.click());
    expect(open).toHaveBeenLastCalledWith(shared.url, '_blank', 'noopener');
    expect(share).toHaveBeenCalledTimes(1);
  });
});
