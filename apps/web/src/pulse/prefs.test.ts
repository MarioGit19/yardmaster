import { describe, expect, it } from 'vitest';
import { pulseCollapsed } from './prefs.js';

describe('pulseCollapsed', () => {
  it('follows the screen until the user picks a state', () => {
    expect(pulseCollapsed('auto', true)).toBe(true);
    expect(pulseCollapsed('auto', false)).toBe(false);
    expect(pulseCollapsed('expanded', true)).toBe(false);
    expect(pulseCollapsed('collapsed', false)).toBe(true);
  });
});
