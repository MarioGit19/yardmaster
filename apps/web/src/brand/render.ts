// Pure string rendering of the logomark source, shared by the app and the icon build script.

/** The accent color written in `logo.svg`; `renderLogo` swaps it out. */
export const LOGO_SOURCE_ACCENT = '#7c9cff';

export interface LogoColors {
  /** The rounded-square ring. `currentColor` inherits the surrounding text color. */
  ring: string;
  /** The orb and its glow. */
  accent: string;
  /** Adds a status dot in the top-right corner. */
  badge?: string;
  /** Color of the gap cut around the badge. */
  badgeGap?: string;
}

const ACCENT_ATTR = new RegExp(`(fill|stop-color)="${LOGO_SOURCE_ACCENT}"`, 'g');

/**
 * Recolors the logomark. Colors go into `style` so CSS variables work inline as well.
 * `idSuffix` keeps gradient ids unique when several marks share a document.
 */
export function renderLogo(source: string, colors: LogoColors, idSuffix = ''): string {
  let svg = source
    .replaceAll('stroke="currentColor"', `style="stroke:${colors.ring}"`)
    .replace(ACCENT_ATTR, (_, prop: string) => `style="${prop}:${colors.accent}"`);
  if (idSuffix) svg = svg.replaceAll('cb-glow', `cb-glow-${idSuffix}`);
  if (colors.badge) {
    const gap = colors.badgeGap ?? '#05060a';
    const dot = `<circle cx="19.5" cy="4.5" r="4" style="fill:${colors.badge};stroke:${gap}" stroke-width="1.5"/>`;
    svg = svg.replace('</svg>', `  ${dot}\n</svg>`);
  }
  return svg.trim();
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
