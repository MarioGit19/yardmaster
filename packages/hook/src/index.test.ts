import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@yardmaster/hook', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@yardmaster/hook');
  });
});
