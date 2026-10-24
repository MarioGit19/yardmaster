import {
  createContext,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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

/** Where the card stands: above its target, or below it where the top would clip (the band). */
export type TipPlacement = 'above' | 'below';

/** A hover card layer over `ref`: the API its stations and bins call, and the card to render. */
export function useTipLayer(
  ref: RefObject<HTMLElement | null>,
  placement: TipPlacement = 'above',
): { api: TipApi; tip: Tip | null } {
  const [tip, setTip] = useState<Tip | null>(null);
  const show = useCallback<TipApi['show']>(
    (target, next) => {
      const box = ref.current?.getBoundingClientRect();
      if (!box) return;
      const rect = target.getBoundingClientRect();
      const y = placement === 'above' ? rect.top : rect.bottom;
      setTip({ ...next, x: rect.left + rect.width / 2 - box.left, y: y - box.top });
    },
    [ref, placement],
  );
  const hide = useCallback<TipApi['hide']>(
    (id) => setTip((current) => (current?.id === id ? null : current)),
    [],
  );
  const api = useMemo(() => ({ show, hide }), [show, hide]);
  return { api, tip };
}

export function TipCard({ tip, placement = 'above' }: { tip: Tip; placement?: TipPlacement }) {
  return (
    <div
      role="tooltip"
      data-transit-tip={tip.id}
      data-placement={placement}
      className="transit-tip pointer-events-none absolute z-20 w-max max-w-70 rounded-control border border-line bg-bg-2 px-3 py-1.5 text-label shadow-raised"
      style={{ left: tip.x, top: tip.y }}
    >
      <p className="flex items-baseline gap-2">
        <span className="font-medium text-text-1">{tip.title}</span>
        {tip.meta && <span className="tabular text-text-2">{tip.meta}</span>}
      </p>
      {tip.detail && (
        <p className="mt-0.5 line-clamp-2 break-words font-mono text-meta text-text-2">
          {tip.detail}
        </p>
      )}
    </div>
  );
}

/** How long a line stays highlighted after its workspace closes (DESIGN.md §10.8). */
export const RETURN_MS = 2400;

let returned: string | null = null;
let returnTimer: ReturnType<typeof setTimeout> | undefined;
const returnListeners = new Set<() => void>();
const setReturned = (next: string | null) => {
  returned = next;
  for (const listener of returnListeners) listener();
};

/**
 * The line whose workspace just closed: the overview highlights it for a moment so the eye finds
 * where it came back to.
 */
export const lineReturn = {
  get: () => returned,
  mark(projectId: string) {
    clearTimeout(returnTimer);
    setReturned(projectId);
    returnTimer = setTimeout(() => setReturned(null), RETURN_MS);
  },
  subscribe(listener: () => void) {
    returnListeners.add(listener);
    return () => returnListeners.delete(listener);
  },
};

/** Whether `projectId`'s line is the one just returned to. */
export const useReturned = (projectId: string) =>
  useSyncExternalStore(lineReturn.subscribe, lineReturn.get) === projectId;

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
  if (event.key === 'Escape' && name && event.target !== name && !event.defaultPrevented) {
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
