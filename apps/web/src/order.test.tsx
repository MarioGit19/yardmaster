// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { keepOrder, useHeldOrder } from './order.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (item: string) => item;

let shown: readonly string[] = [];
function Probe({ items, held }: { items: string[]; held: boolean }) {
  shown = useHeldOrder(items, id, held);
  return null;
}

describe('keepOrder', () => {
  it('keeps the earlier places, newcomers last, gone ones dropped', () => {
    expect(keepOrder(['c', 'new', 'a', 'b'], ['a', 'b', 'c'], id)).toEqual(['a', 'b', 'c', 'new']);
    expect(keepOrder(['c', 'a'], ['a', 'b', 'c'], id)).toEqual(['a', 'c']);
    expect(keepOrder(['b', 'a'], [], id)).toEqual(['b', 'a']);
  });
});

describe('useHeldOrder', () => {
  it('follows the list until held, then keeps the order it had', () => {
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe items={['a', 'b', 'c']} held={false} />));
    act(() => root.render(<Probe items={['b', 'a', 'c']} held={false} />));
    expect(shown).toEqual(['b', 'a', 'c']);
    act(() => root.render(<Probe items={['b', 'a', 'c']} held />));
    act(() => root.render(<Probe items={['c', 'b', 'd', 'a']} held />));
    expect(shown).toEqual(['b', 'a', 'c', 'd']);
    act(() => root.render(<Probe items={['a', 'c', 'b', 'd']} held />));
    expect(shown).toEqual(['b', 'a', 'c', 'd']);
    // Let go: back to the live order.
    act(() => root.render(<Probe items={['a', 'c', 'b', 'd']} held={false} />));
    expect(shown).toEqual(['a', 'c', 'b', 'd']);
    act(() => root.unmount());
  });
});
