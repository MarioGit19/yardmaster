/**
 * Command lines the board offers to run again come from shell markers, which a terminal's own
 * output could imitate. Before a rerun, a line with control characters (other than tab) or bidi
 * overrides is refused, and on screen every such character is shown, never hidden.
 */

// C0 controls but tab, DEL, C1 controls, and the bidi embeddings, overrides and isolates.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE = /[\x00-\x08\x0a-\x1f\x7f-\x9f‪-‮⁦-⁩]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const INVISIBLE = /[\x00-\x08\x0a-\x1f\x7f-\x9f​‌‎‏‪-‮⁠-⁩﻿]/g;

export const UNSAFE_COMMAND_LINE = 'unsafe_command_line';

/** True when `commandLine` may be typed into a shell again. */
export function isSafeCommandLine(commandLine: string): boolean {
  return !UNSAFE.test(commandLine);
}

/**
 * `commandLine` with every control, bidi and zero-width character made visible: C0 controls as
 * their Control Pictures (`␛`, `␊`), DEL as `␡`, the rest as `<U+202E>`. Tab stays a tab.
 */
export function visibleCommandLine(commandLine: string): string {
  return commandLine.replace(INVISIBLE, (ch) => {
    const code = ch.charCodeAt(0);
    if (code < 0x20) return String.fromCharCode(0x2400 + code);
    if (code === 0x7f) return '␡';
    return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
  });
}
