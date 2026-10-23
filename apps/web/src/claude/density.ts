import { createContext, useContext } from 'react';

/**
 * How tightly a chat is laid out: `regular` in the Claude column, `compact` inside the terminal
 * stack (smaller gutters and gaps, no reading-width cap, tool cards collapsed until opened).
 */
export type ChatDensity = 'regular' | 'compact';

export const ChatDensityContext = createContext<ChatDensity>('regular');

export const useCompactChat = () => useContext(ChatDensityContext) === 'compact';

/** The gutter and reading width of a chat's rows, composer and bars. */
export function chatColumn(compact: boolean) {
  return compact
    ? { gutter: 'px-3', measure: 'w-full', dock: 'shrink-0 px-2 pt-1.5 pb-2' }
    : { gutter: 'px-5', measure: 'mx-auto max-w-3xl', dock: 'shrink-0 px-5 pt-2 pb-4' };
}
