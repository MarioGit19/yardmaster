import { describe, expect, it } from 'vitest';
import { boardSocketUrl } from './index.js';

describe('boardSocketUrl', () => {
  it('uses the page origin', () => {
    expect(boardSocketUrl({ protocol: 'http:', host: '127.0.0.1:4317' })).toBe(
      'ws://127.0.0.1:4317/ws/ui',
    );
    expect(boardSocketUrl({ protocol: 'https:', host: 'board.test' })).toBe(
      'wss://board.test/ws/ui',
    );
  });

  it('passes the worst-case demo flag through', () => {
    const at = (search: string) => boardSocketUrl({ protocol: 'http:', host: 'h.test', search });
    expect(at('?worst=1')).toBe('ws://h.test/ws/ui?worst=1');
    expect(at('?theme=dark&worst=1')).toBe('ws://h.test/ws/ui?worst=1');
    expect(at('?worst=0')).toBe('ws://h.test/ws/ui');
    expect(at('')).toBe('ws://h.test/ws/ui');
  });
});
