import { ACCENT_COUNT } from './domain.js';

/**
 * OKLCH hues for project accents (DESIGN.md §2): L=0.72 C=0.14, each more than 15° away from
 * the status hues (work ≈269°, tool ≈211°, wait ≈73°, ok ≈160°, err ≈13°).
 */
export const ACCENT_HUES = [36, 50, 98, 118, 136, 186, 240, 296, 318, 340] as const;
export const ACCENT_LIGHTNESS = 0.72;
export const ACCENT_CHROMA = 0.14;

export interface ProjectAccent {
  index: number;
  hue: number;
  /** CSS color, e.g. `oklch(0.72 0.14 36)`. */
  css: string;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

function* utf8Bytes(input: string): Generator<number> {
  for (const char of input) {
    let cp = char.codePointAt(0) ?? 0;
    // Lone surrogates encode as U+FFFD, matching TextEncoder.
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) {
      yield cp;
    } else if (cp < 0x800) {
      yield 0xc0 | (cp >> 6);
      yield 0x80 | (cp & 0x3f);
    } else if (cp < 0x10000) {
      yield 0xe0 | (cp >> 12);
      yield 0x80 | ((cp >> 6) & 0x3f);
      yield 0x80 | (cp & 0x3f);
    } else {
      yield 0xf0 | (cp >> 18);
      yield 0x80 | ((cp >> 12) & 0x3f);
      yield 0x80 | ((cp >> 6) & 0x3f);
      yield 0x80 | (cp & 0x3f);
    }
  }
}

function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET;
  for (const byte of utf8Bytes(input)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Stable 12-char hex id for a project folder. Pass the realpath; trailing slashes are ignored. */
export function projectIdFromPath(realpath: string): string {
  return fnv1a64(normalizePath(realpath)).toString(16).padStart(16, '0').slice(0, 12);
}

export function accentIndexForProject(id: string): number {
  return Number(fnv1a64(id) % BigInt(ACCENT_COUNT));
}

export function accentForProject(id: string): ProjectAccent {
  const index = accentIndexForProject(id);
  const hue = ACCENT_HUES[index] as number;
  return { index, hue, css: `oklch(${ACCENT_LIGHTNESS} ${ACCENT_CHROMA} ${hue})` };
}
