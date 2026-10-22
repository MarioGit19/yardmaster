import { describe, expect, it } from 'vitest';
import { AltScreenDetector } from './alt-screen.js';

describe('AltScreenDetector', () => {
  it.each(['\x1b[?1049h', '\x1b[?1047h', '\x1b[?47h'])('detects %j', (sequence) => {
    const detector = new AltScreenDetector();
    expect(detector.push(`loading\r\n${sequence}\x1b[H`)).toBe(true);
    expect(detector.detected).toBe(true);
  });

  it('detects a sequence split across chunks, and reports it once', () => {
    const detector = new AltScreenDetector();
    expect(detector.push('out\x1b[?10')).toBe(false);
    expect(detector.push('49h')).toBe(true);
    expect(detector.push('\x1b[?1049h')).toBe(false);
  });

  it('ignores plain output and leaving the alt screen', () => {
    const detector = new AltScreenDetector();
    expect(detector.push('\x1b[32mok\x1b[0m [?1049h\r\n')).toBe(false);
    expect(detector.push('\x1b[?1049l')).toBe(false);
    expect(detector.detected).toBe(false);
  });
});
