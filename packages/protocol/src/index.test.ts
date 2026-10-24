import { describe, expect, it } from 'vitest';
import * as protocol from './index.js';

describe('@yardmaster/protocol', () => {
  it('re-exports the domain model and helpers', () => {
    expect(protocol.PACKAGE_NAME).toBe('@yardmaster/protocol');
    expect(typeof protocol.BoardState.safeParse).toBe('function');
    expect(typeof protocol.projectIdFromPath).toBe('function');
    expect(typeof protocol.accentForProject).toBe('function');
  });
});
