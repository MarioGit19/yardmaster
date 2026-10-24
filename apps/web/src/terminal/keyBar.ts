import { useSyncExternalStore } from 'react';
import { ESC } from './claudeTerminal.js';

/** The phone key bar's keys for a board terminal (DESIGN.md §11), with what each one sends. */
export const BAR_KEYS = [
  { label: 'Tab', name: 'Tab', data: '\t' },
  { label: 'Esc', name: 'Escape', data: ESC },
  { label: '←', name: 'Left arrow', data: `${ESC}[D` },
  { label: '↑', name: 'Up arrow', data: `${ESC}[A` },
  { label: '↓', name: 'Down arrow', data: `${ESC}[B` },
  { label: '→', name: 'Right arrow', data: `${ESC}[C` },
] as const;

/**
 * Ctrl held for the next key: one printable character becomes its control code (`c` → ETX), the
 * way a terminal sends Ctrl+C. Anything else passes through unchanged.
 */
export function withCtrl(data: string): string {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  // @ A–Z [ \ ] ^ _ map to 0–31; `?` is DEL.
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  if (data === '?') return '\u007f';
  if (data === ' ') return '\u0000';
  return data;
}

// The terminals whose Ctrl key is latched, for the page's lifetime.
const latched = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** The key bar's Ctrl: latched until the next key, which it modifies. */
export const ctrlLatch = {
  get: (terminalId: string) => latched.has(terminalId),
  toggle(terminalId: string) {
    if (!latched.delete(terminalId)) latched.add(terminalId);
    notify();
  },
  /** What to send for `data`: Ctrl-modified (and the latch released) while it is latched. */
  apply(terminalId: string, data: string): string {
    if (!latched.delete(terminalId)) return data;
    notify();
    return withCtrl(data);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useCtrlLatched(terminalId: string): boolean {
  const get = () => ctrlLatch.get(terminalId);
  return useSyncExternalStore(ctrlLatch.subscribe, get, get);
}
