import { describe, expect, it } from 'vitest';
import { formatElapsed } from './FocusCaption.js';

describe('formatElapsed', () => {
  it('shows seconds, then minutes with padded seconds', () => {
    expect(formatElapsed(3_400)).toBe('3s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(2 * 3_600_000)).toBe('2h');
    expect(formatElapsed(-5)).toBe('0s');
  });
});
