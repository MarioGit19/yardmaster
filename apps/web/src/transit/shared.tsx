import {
  createContext,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useContext,
  useRef,
} from 'react';
import { useLocation } from 'wouter';
import { useBoardStore } from '../data/index.js';
import { pulseTarget } from '../pulse/model.js';
import { projectHref } from '../routes.js';
import { terminalTarget } from '../terminal/target.js';
import type { ServiceEvent } from './map.js';

/** What the hover card shows, placed over the concourse (it never clips in a row). */
export interface Tip {
  id: string;
  x: number;
  y: number;
  title: string;
  meta: string | null;
  detail: string | null;
}

export interface TipApi {
  show(target: HTMLElement, tip: Omit<Tip, 'x' | 'y'>): void;
  hide(id: string): void;
}

export const TipContext = createContext<TipApi>({ show() {}, hide() {} });
export const useTip = () => useContext(TipContext);

/** Hover (a mouse only) and focus show the card; leaving either hides it. */
export function tipHandlers(api: TipApi, id: string, tip: () => Omit<Tip, 'x' | 'y'>) {
  return {
    onPointerEnter: (e: PointerEvent<HTMLElement>) =>
      e.pointerType === 'mouse' && api.show(e.currentTarget, tip()),
    onPointerLeave: () => api.hide(id),
    onFocus: (e: FocusEvent<HTMLElement>) => api.show(e.currentTarget, tip()),
    onBlur: () => api.hide(id),
  };
}

/** Opens where a logged event happened, like a Pulse dot (§4.7): its session or terminal. */
export function useOpenEvent() {
  const store = useBoardStore();
  const [, navigate] = useLocation();
  return (target: ServiceEvent) => {
    const event = target.event;
    if (!event) {
      navigate(projectHref(target.projectId));
      return;
    }
    const where = pulseTarget(event, store.getState().board);
    if (!where) return;
    if (where.terminal) terminalTarget.set(where.terminal);
    navigate(where.href);
  };
}

/** Ids that arrived after the first render: they scale in once (§10.5). */
export function useFresh(ids: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  if (seen.current === null) {
    seen.current = new Set(ids);
  } else {
    for (const id of ids) {
      if (!seen.current.has(id)) {
        seen.current.add(id);
        fresh.current.add(id);
      }
    }
  }
  return fresh.current;
}

/**
 * The line's name is one Tab stop; arrows move through its stations, trains and log, and Esc
 * goes back to the name (§10.1).
 */
export function lineKeys(event: KeyboardEvent<HTMLElement>) {
  const line = event.currentTarget;
  const name = line.querySelector<HTMLElement>('[data-transit-name]');
  if (event.key === 'Escape' && event.target !== name && !event.defaultPrevented) {
    event.preventDefault();
    name?.focus();
    return;
  }
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step) return;
  const items = [...line.querySelectorAll<HTMLElement>('[data-transit-item]')];
  if (items.length === 0) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = current < 0 ? (step > 0 ? 0 : items.length - 1) : current + step;
  items[(next + items.length) % items.length]?.focus();
}
