import type { ITheme } from '@xterm/xterm';

/**
 * Tokens behind each xterm color. The 8 basic colors follow the lane peek (`lanes/ansi.ts`);
 * bright variants are the same hues mixed toward the foreground.
 */
const TOKENS = {
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

const BRIGHT = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

/** Resolves a CSS color expression (tokens, `color-mix`) to something canvas understands. */
export type ColorResolver = (expression: string) => string;

export function xtermTheme(resolve: ColorResolver): ITheme {
  const theme: ITheme = {};
  for (const [key, token] of Object.entries(TOKENS)) {
    theme[key as keyof typeof TOKENS] = resolve(`var(${token})`);
  }
  for (const name of BRIGHT) {
    const key = `bright${name[0]?.toUpperCase()}${name.slice(1)}` as keyof ITheme;
    const mix =
      name === 'black'
        ? 'var(--text-2)'
        : `color-mix(in srgb, var(${TOKENS[name]}) 80%, var(--text-1))`;
    (theme as Record<string, string>)[key] = resolve(mix);
  }
  theme.selectionBackground = resolve('color-mix(in srgb, var(--st-work) 30%, transparent)');
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
