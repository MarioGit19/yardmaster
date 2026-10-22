import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@c-board/extension', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@c-board/extension');
  });
});
