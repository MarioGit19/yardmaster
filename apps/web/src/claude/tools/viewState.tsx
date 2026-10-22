import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';

type Store = Map<string, boolean>;

const ViewStateContext = createContext<Store>(new Map());

/**
 * Holds the open/closed state of tool cards for one message list. Virtual rows unmount when they
 * scroll away; the state lives here, so a card comes back the way the reader left it.
 */
export function ToolViewState({ children }: { children: ReactNode }) {
  const store = useRef<Store>(new Map());
  return <ViewStateContext value={store.current}>{children}</ViewStateContext>;
}

/**
 * A boolean that survives the component unmounting, keyed within the nearest `ToolViewState`.
 * Until the reader toggles it, it follows `fallback` (a card can open itself when its tool fails).
 */
export function useStickyFlag(key: string, fallback: boolean): [boolean, () => void] {
  const store = useContext(ViewStateContext);
  const [local, setLocal] = useState<{ key: string; value: boolean } | null>(null);
  // A changed key (a different row in this slot) drops the local value and reads the store.
  const value = (local?.key === key ? local.value : store.get(key)) ?? fallback;
  const toggle = useCallback(() => {
    store.set(key, !value);
    setLocal({ key, value: !value });
  }, [store, key, value]);
  return [value, toggle];
}
