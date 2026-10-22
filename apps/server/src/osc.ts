const OSC_633 = '\x1b]633;';
const BEL = '\x07';
const ST = '\x1b\\';

/** Longest marker prefix kept back while waiting for the next chunk. */
const MARKER_TAIL = OSC_633.length - 1;

export interface OscStripper {
  /** Returns `chunk` with every VS Code OSC 633 sequence removed; ANSI stays. */
  push(chunk: string): string;
  /** Releases text held back as a possible marker start (end of stream). */
  flush(): string;
}

/**
 * Stateful OSC 633 stripper. Sequences (`ESC ] 633 ; … BEL|ESC \`) may be
 * split across chunks, so a partial marker or an unterminated sequence is
 * carried over to the next push instead of leaking into the output.
 */
export function createOscStripper(): OscStripper {
  let inSequence = false;
  let carry = '';

  return {
    push(chunk) {
      const text = carry + chunk;
      carry = '';
      let out = '';
      let i = 0;

      while (i < text.length) {
        if (inSequence) {
          const bel = text.indexOf(BEL, i);
          const st = text.indexOf(ST, i);
          const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
          if (end === -1) {
            // Payload continues in the next chunk; keep a trailing ESC in case it starts ST.
            if (text.endsWith('\x1b')) carry = '\x1b';
            return out;
          }
          i = end + (end === bel ? BEL.length : ST.length);
          inSequence = false;
          continue;
        }

        const start = text.indexOf(OSC_633, i);
        if (start !== -1) {
          out += text.slice(i, start);
          i = start + OSC_633.length;
          inSequence = true;
          continue;
        }

        let esc = text.indexOf('\x1b', Math.max(i, text.length - MARKER_TAIL));
        while (esc !== -1 && !OSC_633.startsWith(text.slice(esc))) {
          esc = text.indexOf('\x1b', esc + 1);
        }
        if (esc !== -1) {
          out += text.slice(i, esc);
          carry = text.slice(esc);
        } else {
          out += text.slice(i);
        }
        return out;
      }
      return out;
    },
    flush() {
      const rest = inSequence ? '' : carry;
      carry = '';
      inSequence = false;
      return rest;
    },
  };
}

/** One-shot strip for a complete string. */
export function stripOsc633(text: string): string {
  const stripper = createOscStripper();
  return stripper.push(text) + stripper.flush();
}
