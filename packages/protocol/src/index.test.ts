import { describe, expect, it } from 'vitest';
import * as protocol from './index.js';

describe('@c-board/protocol', () => {
  it('re-exports the domain model and helpers', () => {
    expect(protocol.PACKAGE_NAME).toBe('@c-board/protocol');
    expect(typeof protocol.BoardState.safeParse).toBe('function');
    expect(typeof protocol.projectIdFromPath).toBe('function');
    expect(typeof protocol.accentForProject).toBe('function');
  });
});
