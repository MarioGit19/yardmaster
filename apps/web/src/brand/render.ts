// Pure string rendering of the logomark source, shared by the app and the brand build script.

/** The accent color written in `logo.svg`; `renderLogo` swaps it out. */
export const LOGO_SOURCE_ACCENT = '#7c9cff';

export interface LogoColors {
  /** The Y. `currentColor` inherits the surrounding text color. */
  ink: string;
  /** The orb at the hub. */
  accent: string;
  /** Adds a status dot in the empty bottom-right corner. */
  badge?: string;
}

/**
 * Night status colors for the favicon states (tokens.css): favicons can't read CSS variables. The
 * idle grey is a midtone, so the Y reads on both light and dark tab strips.
 */
export const FAVICON_COLORS = {
  idle: { ink: '#8a90a0', accent: '#7c9cff' },
  wait: { ink: '#ffb547', accent: '#ffb547', badge: '#ffb547' },
  err: { ink: '#ff5c7a', accent: '#ff5c7a' },
} as const satisfies Record<string, LogoColors>;

const ACCENT_FILL = `fill="${LOGO_SOURCE_ACCENT}"`;

/** Recolors the logomark. Colors go into `style` so CSS variables work inline as well. */
export function renderLogo(source: string, colors: LogoColors): string {
  let svg = source
    .replaceAll('fill="currentColor"', `style="fill:${colors.ink}"`)
    .replaceAll(ACCENT_FILL, `style="fill:${colors.accent}"`);
  if (colors.badge) {
    const dot = `<circle cx="212" cy="212" r="36" style="fill:${colors.badge}"/>`;
    svg = svg.replace('</svg>', `  ${dot}\n</svg>`);
  }
  return svg.trim();
}

export interface LogoParts {
  viewBox: string;
  /** The Y's three strokes, in source order: left arm, right arm, stem. */
  strokes: string[];
  orb: { cx: number; cy: number; r: number };
}

/** Pulls the mark apart for code that draws it piece by piece (the onboarding brand moment). */
export function parseLogo(source: string): LogoParts {
  const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1] ?? '0 0 256 256';
  const strokes = [...source.matchAll(/<path fill="currentColor" d="([^"]+)"/g)].map(
    (m) => m[1] ?? '',
  );
  const orb = /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/.exec(source);
  return {
    viewBox,
    strokes,
    orb: { cx: Number(orb?.[1] ?? 0), cy: Number(orb?.[2] ?? 0), r: Number(orb?.[3] ?? 0) },
  };
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
