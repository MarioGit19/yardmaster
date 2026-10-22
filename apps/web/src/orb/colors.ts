import type { Rgb } from './render.js';

const cache = new Map<string, Rgb>();
let probe: HTMLSpanElement | null = null;
let pixel: CanvasRenderingContext2D | null | undefined;

const FALLBACK: Rgb = [128, 128, 128];

/** Paints a computed color into one pixel to read it back, whatever color space it uses. */
function toRgb(computed: string): Rgb {
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(computed);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  if (pixel === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    pixel = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!pixel) return FALLBACK;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = '#808080';
  pixel.fillStyle = computed;
  pixel.fillRect(0, 0, 1, 1);
  const [r = 128, g = 128, b = 128] = pixel.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/**
 * Resolves a CSS color (`var(--st-work)`, `oklch(…)`, a hex) to sRGB for canvas gradients.
 * Cached per applied theme, since tokens change with it.
 */
export function resolveColor(value: string): Rgb {
  const key = `${document.documentElement.dataset.theme ?? 'dark'}|${value}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!probe) {
    probe = document.createElement('span');
    probe.style.display = 'none';
    document.body.append(probe);
  }
  probe.style.color = '';
  probe.style.color = value;
  const rgb = toRgb(getComputedStyle(probe).color);
  cache.set(key, rgb);
  return rgb;
}
