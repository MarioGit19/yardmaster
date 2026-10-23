// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { QrCode } from './PhoneSettings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('QrCode', () => {
  it('draws square modules on a white tile with a quiet zone', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(<QrCode value="https://dev-mac.tailnet-acme.ts.net/pair?c=abc" />));
    const svg = container.querySelector('svg[data-qr]');
    const size = Number(svg?.getAttribute('viewBox')?.split(' ')[2]);
    // Version 4 (33 modules) for a link this long at level M, plus a 3-module quiet zone each side.
    expect(size).toBe(39);
    const d = svg?.querySelector('path')?.getAttribute('d') ?? '';
    const modules = d.match(/M(\d+) (\d+)/g) ?? [];
    expect(modules.length).toBeGreaterThan(100);
    // The finder pattern's corner starts inside the border.
    expect(modules[0]).toBe('M3 3');
    for (const m of modules) {
      const [x, y] = m.slice(1).split(' ').map(Number);
      expect(Math.min(x ?? 0, y ?? 0)).toBeGreaterThanOrEqual(3);
      expect(Math.max(x ?? 0, y ?? 0)).toBeLessThan(size - 3);
    }
    act(() => root.unmount());
  });
});
