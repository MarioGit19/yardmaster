// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createResizeMark, RESIZE_END, RESIZING_ATTR, resizingAncestor } from './resizing.js';

describe('createResizeMark', () => {
  it('marks the container until the last source ends, then fires RESIZE_END once', () => {
    const root = document.createElement('div');
    const child = document.createElement('span');
    root.append(child);
    const ended = vi.fn();
    root.addEventListener(RESIZE_END, ended);
    const mark = createResizeMark(() => root);

    expect(resizingAncestor(child)).toBeNull();
    mark.start('left');
    mark.start('right');
    expect(root.hasAttribute(RESIZING_ATTR)).toBe(true);
    expect(resizingAncestor(child)).toBe(root);

    mark.end('left');
    expect(root.hasAttribute(RESIZING_ATTR)).toBe(true);
    expect(ended).not.toHaveBeenCalled();
    mark.end('right');
    expect(root.hasAttribute(RESIZING_ATTR)).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);

    // Ending a source that isn't active does nothing.
    mark.end('right');
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('tolerates a missing container', () => {
    const mark = createResizeMark(() => null);
    expect(() => {
      mark.start('left');
      mark.end('left');
    }).not.toThrow();
  });
});
