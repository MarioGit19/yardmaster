/**
 * Project accent hues (OKLCH, L=0.72 C=0.14), DESIGN.md §2. Each sits at least 15° away from
 * every status hue so an accent never reads as a status. Mirrors `--accent-0..9` in tokens.css.
 */
export const ACCENT_HUES = [35, 50, 95, 115, 135, 185, 240, 295, 320, 345] as const;

/** Stable accent index for a project path (FNV-1a, so it survives restarts and machines). */
export function accentIndex(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % ACCENT_HUES.length;
}

export function accentVar(path: string): string {
  return `var(--accent-${accentIndex(path)})`;
}
