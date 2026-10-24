import { describe, expect, it } from 'vitest';
import { ctrlLatch, withCtrl } from './keyBar.js';

describe('withCtrl', () => {
  it('turns a letter into its control code, either case', () => {
    expect(withCtrl('c')).toBe('\u0003');
    expect(withCtrl('C')).toBe('\u0003');
    expect(withCtrl('[')).toBe('\u001b');
    expect(withCtrl(' ')).toBe('\u0000');
  });

  it('leaves longer input and other characters alone', () => {
    expect(withCtrl('ls')).toBe('ls');
    expect(withCtrl('1')).toBe('1');
  });
});

describe('ctrlLatch', () => {
  it('modifies only the next key, then lets go', () => {
    expect(ctrlLatch.apply('t-1', 'c')).toBe('c');
    ctrlLatch.toggle('t-1');
    expect(ctrlLatch.get('t-1')).toBe(true);
    expect(ctrlLatch.apply('t-2', 'c')).toBe('c');
    expect(ctrlLatch.apply('t-1', 'c')).toBe('\u0003');
    expect(ctrlLatch.get('t-1')).toBe(false);
    expect(ctrlLatch.apply('t-1', 'c')).toBe('c');
  });
});
