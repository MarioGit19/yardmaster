/**
 * A container whose size is animating (a column drag or settle spring) carries
 * `data-resizing`. Expensive size followers (xterm's fit) wait for it to go and do their work
 * once, on the `RESIZE_END` event the container dispatches when it clears the mark.
 */
export const RESIZING_ATTR = 'data-resizing';
export const RESIZE_END = 'yardmaster:resize-end';

/** The resizing ancestor of `el` (or `el` itself), if a resize is running. */
export function resizingAncestor(el: Element): Element | null {
  return el.closest(`[${RESIZING_ATTR}]`);
}

/**
 * Marks `el` as resizing while any of its sources (e.g. its two handles) is active; clears the
 * mark and dispatches `RESIZE_END` on `el` when the last one ends.
 */
export function createResizeMark(el: () => Element | null) {
  const active = new Set<string>();
  return {
    start(source: string) {
      active.add(source);
      el()?.setAttribute(RESIZING_ATTR, '');
    },
    end(source: string) {
      if (!active.delete(source) || active.size > 0) return;
      const node = el();
      if (!node) return;
      node.removeAttribute(RESIZING_ATTR);
      node.dispatchEvent(new Event(RESIZE_END));
    },
  };
}

export type ResizeMark = ReturnType<typeof createResizeMark>;
