// @vitest-environment happy-dom
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SegmentThumb, useSegmentThumb } from './SegmentThumb.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const seen: { layoutId: string; byKeyboard: boolean }[] = [];

beforeEach(() => {
  MotionGlobalConfig.skipAnimations = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  seen.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  MotionGlobalConfig.skipAnimations = false;
});

function Toggle({ name }: { name: string }) {
  const thumb = useSegmentThumb();
  seen.push({ layoutId: thumb.layoutId, byKeyboard: thumb.byKeyboard });
  return (
    <button type="button" data-toggle={name} onClick={thumb.pick} className="relative">
      <SegmentThumb layoutId={thumb.layoutId} byKeyboard={thumb.byKeyboard} className="bg-bg-1" />
    </button>
  );
}

describe('useSegmentThumb', () => {
  it('gives each control instance its own layoutId', () => {
    act(() =>
      root.render(
        <>
          <Toggle name="a" />
          <Toggle name="b" />
        </>,
      ),
    );
    const [a, b] = seen;
    expect(a?.layoutId).toBeTruthy();
    expect(a?.layoutId).not.toBe(b?.layoutId);
    expect(container.querySelectorAll('[data-segment-thumb]')).toHaveLength(2);
  });

  it('snaps for a keyboard pick and glides for a pointer pick', () => {
    act(() => root.render(<Toggle name="a" />));
    const button = container.querySelector('[data-toggle="a"]') as HTMLButtonElement;
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })));
    expect(seen.at(-1)?.byKeyboard).toBe(true);
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(seen.at(-1)?.byKeyboard).toBe(false);
  });
});
