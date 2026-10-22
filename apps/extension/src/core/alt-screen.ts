/** DEC private modes that switch to the alternate screen buffer (TUIs such as htop or claude). */
const ALT_SCREEN = ['\x1b[?1049h', '\x1b[?1047h', '\x1b[?47h'];
/** This much of the previous chunk is kept, so a sequence split across chunks still matches. */
const CARRY = Math.max(...ALT_SCREEN.map((sequence) => sequence.length)) - 1;

/** Watches a stream of output chunks for the switch to the alternate screen. */
export class AltScreenDetector {
  private tail = '';
  private seen = false;

  get detected(): boolean {
    return this.seen;
  }

  /** Returns true for the chunk that completes the first alt-screen switch. */
  push(chunk: string): boolean {
    if (this.seen) return false;
    const text = this.tail + chunk;
    if (ALT_SCREEN.some((sequence) => text.includes(sequence))) {
      this.seen = true;
      this.tail = '';
      return true;
    }
    this.tail = text.slice(-CARRY);
    return false;
  }
}
