import type { ITheme } from '@xterm/xterm';
import type { SkinId } from '../focus/skins/registry.js';

/**
 * Tokens behind each xterm color. The 8 basic colors follow the lane peek (`lanes/ansi.ts`);
 * bright variants are the same hues mixed toward the foreground.
 */
const MINIMAL = {
  background: '--bg-0',
  foreground: '--text-1',
  cursor: '--text-2',
  cursorAccent: '--bg-0',
  black: '--text-3',
  red: '--st-err',
  green: '--st-ok',
  yellow: '--st-wait',
  blue: '--st-work',
  magenta: '--orb-edit',
  cyan: '--st-tool',
  white: '--text-2',
} as const satisfies Partial<Record<keyof ITheme, string>>;

type Palette = Record<keyof typeof MINIMAL, string>;

/**
 * Retro's workspace (DESIGN.md §10.8): phosphor on the tube's black (ink on paper in Daylight),
 * the ANSI hues at the console's reduced saturation. Tokens from the skin's scope.
 */
const RETRO: Palette = {
  background: '--retro-bg',
  foreground: '--retro-ink',
  cursor: '--retro-ink',
  cursorAccent: '--retro-bg',
  black: '--retro-dim-ink',
  red: '--retro-tone-err',
  green: '--retro-tone-ok',
  yellow: '--retro-tone-wait',
  blue: '--retro-tone-work',
  magenta: '--retro-tone-edit',
  cyan: '--retro-tone-tool',
  white: '--retro-ink',
};

/**
 * Grid's workspace (DESIGN.md §10.8): neon on the Grid's near-black, a neon cursor, cyan as the
 * structural neon itself, the other hues at full status strength. Tokens from the skin's scope.
 */
const GRID: Palette = {
  background: '--grid-bg',
  foreground: '--gs-term-fg',
  cursor: '--grid-neon',
  cursorAccent: '--grid-bg',
  black: '--text-3',
  red: '--st-err',
  green: '--st-ok',
  yellow: '--st-wait',
  blue: '--st-work',
  magenta: '--orb-edit',
  cyan: '--grid-neon',
  white: '--text-2',
};

/** Bright black: the dim text of each skin. */
const BRIGHT_BLACK: Record<SkinId, string> = {
  minimal: '--text-2',
  office: '--text-2',
  grid: '--text-2',
  transit: '--text-2',
  retro: '--retro-dim-ink',
};

// Office's monitors and Transit's panels show the standard terminal: the world is in the frame,
// not in the text.
const PALETTES: Record<SkinId, Palette> = {
  minimal: MINIMAL,
  office: MINIMAL,
  grid: GRID,
  transit: MINIMAL,
  retro: RETRO,
};

const SELECTION: Record<SkinId, string> = {
  minimal: '--st-work',
  office: '--st-work',
  grid: '--grid-neon',
  transit: '--st-work',
  retro: '--retro-ink',
};

const BRIGHT = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

/** Resolves a CSS color expression (tokens, `color-mix`) to something canvas understands. */
export type ColorResolver = (expression: string) => string;

/** The terminal colors of a workspace skin (Minimal's outside the workspace). */
export function xtermTheme(resolve: ColorResolver, skin: SkinId = 'minimal'): ITheme {
  const tokens = PALETTES[skin];
  const theme: ITheme = {};
  for (const [key, token] of Object.entries(tokens)) {
    theme[key as keyof Palette] = resolve(`var(${token})`);
  }
  for (const name of BRIGHT) {
    const key = `bright${name[0]?.toUpperCase()}${name.slice(1)}` as keyof ITheme;
    const mix =
      name === 'black'
        ? `var(${BRIGHT_BLACK[skin]})`
        : `color-mix(in srgb, var(${tokens[name]}) 80%, var(${tokens.foreground}))`;
    (theme as Record<string, string>)[key] = resolve(mix);
  }
  theme.selectionBackground = resolve(
    `color-mix(in srgb, var(${SELECTION[skin]}) 30%, transparent)`,
  );
  theme.selectionInactiveBackground = resolve('color-mix(in srgb, var(--text-3) 25%, transparent)');
  theme.scrollbarSliderBackground = resolve('var(--line-strong)');
  theme.scrollbarSliderHoverBackground = resolve(
    'color-mix(in srgb, var(--text-3) 60%, transparent)',
  );
  theme.scrollbarSliderActiveBackground = resolve('var(--text-3)');
  theme.overviewRulerBorder = resolve('transparent');
  return theme;
}

/**
 * Resolves colors through a hidden probe element inside `host`, so tokens follow the theme
 * that applies there, then reads the pixel back from a 1×1 canvas: computed `color-mix()`
 * comes out as `color(srgb …)`, which xterm doesn't parse.
 */
export function domColorResolver(host: HTMLElement): { resolve: ColorResolver; dispose(): void } {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  host.appendChild(probe);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    resolve(expression) {
      probe.style.color = '';
      probe.style.color = expression;
      const computed = getComputedStyle(probe).color || expression;
      if (!ctx) return computed;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = computed;
      ctx.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 255
        ? `rgb(${r}, ${g}, ${b})`
        : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
    },
    dispose: () => probe.remove(),
  };
}
