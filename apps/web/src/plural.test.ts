import { describe, expect, it } from 'vitest';
import { countOf, plural } from './plural.js';

describe('plural', () => {
  it('picks the singular for one and the plural for everything else', () => {
    expect(plural(1, 'error')).toBe('error');
    expect(plural(0, 'error')).toBe('errors');
    expect(plural(2, 'error')).toBe('errors');
    expect(plural(1.5, 'error')).toBe('errors');
  });

  it('takes an irregular plural', () => {
    expect(plural(2, 'device stays', 'devices stay')).toBe('devices stay');
    expect(countOf(1, 'needs', 'need')).toBe('1 needs');
  });

  it('writes the count with its word', () => {
    expect(countOf(1, 'error')).toBe('1 error');
    expect(countOf(3, 'error')).toBe('3 errors');
  });
});
