// The brand build (DESIGN.md §4.9): renders every brand asset from src/brand/logo.svg with
// headless Chromium, so nothing binary is drawn by hand.
// Usage: tsx scripts/render-icons.ts [--force] [--strict] [--all]
//   --force   re-render even when the outputs are newer than their sources
//   --strict  fail instead of warning when Chromium can't be launched
//   --all     also write the committed README hero (docs/brand/) and the brand kit and sheet
//             (artifacts/brand/); `pnpm brand:build` passes all three
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { BRAND_NAME, TAGLINE, WORDMARK } from '../src/brand/name.js';
import { FAVICON_COLORS, renderLogo } from '../src/brand/render.js';

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const require = createRequire(import.meta.url);

const LOGO = path('../src/brand/logo.svg');
const SOURCES = [
  LOGO,
  path('../src/brand/render.ts'),
  path('../src/brand/name.ts'),
  fileURLToPath(import.meta.url),
];
const PUBLIC = path('../public/');
const DOCS = path('../../../docs/brand/');
const KIT = path('../../../artifacts/brand/');

// Night and Daylight tokens (tokens.css).
const NIGHT = {
  bg0: '#05060a',
  bg1: '#0a0c12',
  text1: '#edeff5',
  text2: '#a3a9b8',
  work: '#7c9cff',
};
const DAY = { bg0: '#f7f7f4', bg1: '#ffffff', text1: '#0e1116', text2: '#4a505e', work: '#5a77d6' };
type Theme = typeof NIGHT;

/** The orb's center as a fraction of the mark's box, for the glow behind it on tiles. */
const ORB = { x: 128 / 256, y: 114 / 256 };

/** The wordmark: Geist 600, tracked in by 2.5% (the `.wordmark` class in index.css). */
const WORD = { weight: 600, tracking: -0.025 };
/** Lockup proportions, in units of the wordmark's font size. */
const LOCKUP = { mark: 1.5, gap: 0.34 };

const fontFile = (pkg: string, file: string) =>
  require.resolve(`@fontsource-variable/${pkg}/files/${file}`);

async function fontDataUrl(file: string): Promise<string> {
  return `data:font/woff2;base64,${(await readFile(file)).toString('base64')}`;
}

interface Fonts {
  sans: string;
  /** Left out of standalone SVGs, which only set the wordmark and tagline. */
  mono?: string;
}

const fontFaces = (fonts: Fonts) =>
  `@font-face{font-family:"Geist";src:url(${fonts.sans}) format("woff2");font-weight:100 900}` +
  (fonts.mono
    ? `@font-face{font-family:"Geist Mono";src:url(${fonts.mono}) format("woff2");font-weight:100 900}`
    : '');

const sized = (svg: string, w: number | string, h: number | string = w) =>
  svg.replace('<svg ', `<svg width="${w}" height="${h}" `);

const flat = (svg: string) => svg.replace(/\s*\n\s*/g, '');

// ---------------------------------------------------------------------------------------------
// Icons

type TileShape = 'bleed' | 'rounded';

/** The app-icon tile: the mark lit on Night, with a soft glow behind the orb. */
function tileHtml(mark: string, size: number, shape: TileShape, markScale: number): string {
  const markSize = Math.round(size * markScale);
  const glow = Math.round(markSize * 0.62);
  const orbX = (size - markSize) / 2 + markSize * ORB.x;
  const orbY = (size - markSize) / 2 + markSize * ORB.y;
  const radius = shape === 'rounded' ? Math.round(size * 0.225) : 0;
  return `<div id="shot" style="position:relative;width:${size}px;height:${size}px;overflow:hidden;border-radius:${radius}px;
background:radial-gradient(120% 90% at 50% 0%, #141828 0%, ${NIGHT.bg1} 55%, ${NIGHT.bg0} 100%);
${shape === 'rounded' ? `box-shadow:inset 0 0 0 ${Math.max(1, size / 128)}px rgb(255 255 255 / .08);` : ''}">
<div style="position:absolute;left:${orbX - glow / 2}px;top:${orbY - glow / 2}px;width:${glow}px;height:${glow}px;border-radius:50%;
background:radial-gradient(circle, rgb(124 156 255 / .45) 0%, rgb(124 156 255 / 0) 68%)"></div>
<div style="position:absolute;inset:0;display:grid;place-items:center">${sized(mark, markSize)}</div></div>`;
}

const bareHtml = (svg: string, size: number) =>
  `<div id="shot" style="width:${size}px;height:${size}px">${sized(svg, '100%')}</div>`;

interface Raster {
  file: string;
  width: number;
  height: number;
  html: string;
}

async function screenshot(page: Page, fonts: Fonts, shot: Raster): Promise<void> {
  await page.setViewportSize({ width: shot.width, height: shot.height });
  await page.setContent(
    `<!doctype html><html><head><style>${fontFaces(fonts)}*{box-sizing:border-box}body{margin:0;background:transparent}</style></head><body>${shot.html}</body></html>`,
  );
  await page.evaluate(() => document.fonts.ready);
  await mkdir(dirname(shot.file), { recursive: true });
  await page.locator('#shot').screenshot({ path: shot.file, omitBackground: true });
}

// ---------------------------------------------------------------------------------------------
// Wordmark and lockups as SVG (the font is embedded, so they render anywhere, GitHub included)

interface WordMetrics {
  /** Advance width of the wordmark at 100 px. */
  width: number;
  /** Ascender (the d) above the baseline, at 100 px. */
  ascent: number;
}

async function measureWordmark(page: Page, fonts: Fonts): Promise<WordMetrics> {
  await page.setContent(
    `<!doctype html><html><head><style>${fontFaces(fonts)}</style></head><body><span style="font:600 100px Geist">${WORDMARK}</span></body></html>`,
  );
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(
    ({ word, weight, tracking }) => {
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) throw new Error('no canvas');
      ctx.font = `${weight} 100px Geist`;
      ctx.letterSpacing = `${tracking * 100}px`;
      const m = ctx.measureText(word);
      // Canvas adds the tracking after the last letter too; the word ends at its last glyph.
      return {
        width: m.width - tracking * 100,
        ascent: ctx.measureText('d').actualBoundingBoxAscent,
      };
    },
    { word: WORDMARK, weight: WORD.weight, tracking: WORD.tracking },
  );
}

interface Lockup {
  width: number;
  height: number;
  /** Inner SVG markup, positioned from (0, 0). */
  body: string;
}

/** Mark + wordmark, the mark centered on the word's ascender height (like `items-center`). */
function lockup(
  mark: string,
  metrics: WordMetrics,
  size: number,
  ink: string,
  withMark = true,
): Lockup {
  const markSize = withMark ? size * LOCKUP.mark : 0;
  const gap = withMark ? size * LOCKUP.gap : 0;
  const ascent = (metrics.ascent / 100) * size;
  const descent = size * 0.24;
  const height = Math.max(markSize, ascent + descent);
  const baseline = height / 2 + ascent / 2;
  const width = markSize + gap + (metrics.width / 100) * size;
  const markSvg = withMark
    ? sized(mark, markSize).replace('<svg ', `<svg x="0" y="${(height - markSize) / 2}" `)
    : '';
  const text = `<text x="${markSize + gap}" y="${baseline}" font-family="Geist, sans-serif" font-weight="${WORD.weight}" font-size="${size}" letter-spacing="${WORD.tracking * size}" fill="${ink}">${WORDMARK}</text>`;
  return { width, height, body: markSvg + text };
}

function svgDoc(width: number, height: number, body: string, fonts?: Fonts, label = BRAND_NAME) {
  const r = (n: number) => Math.round(n * 100) / 100;
  const style = fonts ? `<style>${fontFaces({ sans: fonts.sans })}</style>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r(width)} ${r(height)}" fill="none" role="img" aria-label="${label}">${style}${body}</svg>\n`;
}

/** The README hero: lockup and tagline on a transparent ground, for GitHub's light or dark page. */
function hero(source: string, metrics: WordMetrics, fonts: Fonts, theme: Theme): string {
  const W = 1280;
  const H = 400;
  const mark = flat(renderLogo(source, { ink: theme.text1, accent: theme.work }));
  const l = lockup(mark, metrics, 96, theme.text1);
  const x = (W - l.width) / 2;
  const y = 110;
  const glowX = x + 96 * LOCKUP.mark * ORB.x;
  const glowY = y + (l.height - 96 * LOCKUP.mark) / 2 + 96 * LOCKUP.mark * ORB.y;
  const body =
    `<defs><radialGradient id="ym-glow"><stop offset="0" stop-color="${theme.work}" stop-opacity="${theme === NIGHT ? 0.35 : 0.18}"/><stop offset="1" stop-color="${theme.work}" stop-opacity="0"/></radialGradient></defs>` +
    `<circle cx="${glowX}" cy="${glowY}" r="84" fill="url(#ym-glow)"/>` +
    `<g transform="translate(${x} ${y})">${l.body}</g>` +
    `<text x="${W / 2}" y="${y + l.height + 72}" text-anchor="middle" font-family="Geist, sans-serif" font-weight="400" font-size="28" fill="${theme.text2}">${TAGLINE}</text>`;
  return svgDoc(W, H, body, fonts);
}

// ---------------------------------------------------------------------------------------------
// Social image and the brand sheet

function socialHtml(source: string, metrics: WordMetrics): string {
  const mark = flat(renderLogo(source, { ink: NIGHT.text1, accent: NIGHT.work }));
  const l = lockup(mark, metrics, 112, NIGHT.text1);
  // A quiet row of status lights: the board at a glance, one of them waiting.
  const lights = ['#7c9cff', '#3ddc97', '#5ee7ff', '#ffb547', '#6b7183', '#7c9cff', '#3ddc97']
    .map(
      (c, i) =>
        `<span style="width:14px;height:14px;border-radius:50%;background:${c};box-shadow:0 0 18px ${c}${i === 3 ? '' : '66'};opacity:${i === 3 ? 1 : 0.7}"></span>`,
    )
    .join('');
  return `<div id="shot" style="position:relative;width:1200px;height:630px;overflow:hidden;font-family:Geist;
background:radial-gradient(60% 70% at 18% 20%, #121a3a 0%, transparent 70%),radial-gradient(50% 60% at 90% 100%, #1a1230 0%, transparent 70%),${NIGHT.bg0}">
<div style="position:absolute;left:96px;top:200px">${svgDoc(l.width, l.height, l.body).replace('<svg ', `<svg width="${l.width}" height="${l.height}" `)}</div>
<p style="position:absolute;left:96px;top:${200 + l.height + 36}px;margin:0;font-size:34px;line-height:1.3;color:${NIGHT.text2};max-width:1000px">${TAGLINE}</p>
<div style="position:absolute;left:96px;bottom:72px;display:flex;gap:14px">${lights}</div>
</div>`;
}

const img = (svg: string, w: number, h: number = w, extra = '') =>
  `<img src="data:image/svg+xml,${encodeURIComponent(svg)}" width="${w}" height="${h}" style="${extra}" alt="">`;
const png = async (file: string, w: number, h: number = w, extra = '') =>
  `<img src="data:image/png;base64,${(await readFile(file)).toString('base64')}" width="${w}" height="${h}" style="${extra}" alt="">`;

async function sheetHtml(source: string, metrics: WordMetrics, fonts: Fonts): Promise<string> {
  const panel = async (theme: Theme, name: string) => {
    const color = renderLogo(source, { ink: theme.text1, accent: theme.work });
    const one = renderLogo(source, { ink: theme.text1, accent: theme.text1 });
    const l = lockup(flat(color), metrics, 44, theme.text1);
    const w = lockup('', metrics, 44, theme.text1, false);
    const strip = theme === NIGHT ? '#202124' : '#dee1e6';
    const tabs = (['idle', 'wait', 'err'] as const)
      .map(
        (s) =>
          `<div style="display:flex;align-items:center;gap:8px;background:${theme === NIGHT ? '#35363a' : '#fff'};border-radius:8px 8px 0 0;padding:8px 12px;font:12px Geist;color:${theme === NIGHT ? '#e8eaed' : '#3c4043'}">${img(renderLogo(source, FAVICON_COLORS[s]), 16)}<span>${s === 'wait' ? `(2) ${BRAND_NAME}` : BRAND_NAME}</span></div>`,
      )
      .join('');
    const ladder = [16, 24, 32, 64, 128, 256].map((s) => img(color, s)).join('');
    return `<section style="background:${theme.bg0};color:${theme.text2};padding:48px;display:flex;flex-direction:column;gap:40px">
<h2 style="margin:0;font:500 14px Geist;color:${theme.text2}">${name}</h2>
<div style="display:flex;align-items:flex-end;gap:32px">${ladder}</div>
<div style="display:flex;align-items:center;gap:56px">${img(svgDoc(l.width, l.height, l.body, fonts), l.width, l.height)}${img(svgDoc(w.width, w.height, w.body, fonts), w.width, w.height)}</div>
<div style="display:flex;align-items:center;gap:32px">${img(one, 64)}${img(renderLogo(source, { ink: theme.text1, accent: 'none' }), 64)}<span style="font:13px Geist">one color · Y alone</span></div>
<div style="display:flex;gap:4px;background:${strip};padding:8px 8px 0;border-radius:10px;width:fit-content">${tabs}</div>
</section>`;
  };
  const icons = [
    await png(`${PUBLIC}icon-512.png`, 128),
    await png(`${PUBLIC}icon-maskable-512.png`, 128, 128, 'border-radius:50%'),
    await png(`${PUBLIC}icon-maskable-512.png`, 128, 128, 'border-radius:28px'),
    await png(`${PUBLIC}apple-touch-icon.png`, 128, 128, 'border-radius:28px'),
    await png(`${PUBLIC}icon-monochrome-512.png`, 128, 128, 'background:#3b4a6b;border-radius:50%'),
    await png(`${PUBLIC}favicon.png`, 32),
  ].join('');
  return `<div id="shot" style="width:1600px;font-family:Geist">
<div style="display:grid;grid-template-columns:1fr 1fr">${await panel(NIGHT, 'Night')}${await panel(DAY, 'Daylight')}</div>
<section style="background:#14161c;padding:48px;display:flex;flex-direction:column;gap:32px;color:#a3a9b8">
<h2 style="margin:0;font:500 14px Geist">App icons: any · maskable (circle, squircle) · iOS · Android monochrome · favicon</h2>
<div style="display:flex;align-items:center;gap:40px">${icons}</div>
<h2 style="margin:0;font:500 14px Geist">Social image and README hero</h2>
<div style="display:flex;gap:24px;align-items:flex-start">${await png(`${PUBLIC}og-image.png`, 600, 315, 'border-radius:12px')}
<div style="display:flex;flex-direction:column;gap:12px">
${img(await readFile(`${DOCS}hero-dark.svg`, 'utf8'), 640, 200, `background:#0d1117;border-radius:12px`)}
${img(await readFile(`${DOCS}hero-light.svg`, 'utf8'), 640, 200, `background:#ffffff;border-radius:12px`)}</div></div>
</section></div>`;
}

// ---------------------------------------------------------------------------------------------

async function mtime(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function upToDate(outputs: string[]): Promise<boolean> {
  const newestSource = Math.max(...(await Promise.all(SOURCES.map(mtime))));
  const times = await Promise.all(outputs.map(mtime));
  return times.every((t) => t > newestSource);
}

async function write(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const all = args.has('--all');
  const source = await readFile(LOGO, 'utf8');
  const fonts: Fonts = {
    sans: await fontDataUrl(fontFile('geist', 'geist-latin-wght-normal.woff2')),
    mono: await fontDataUrl(fontFile('geist-mono', 'geist-mono-latin-wght-normal.woff2')),
  };

  const lit = flat(renderLogo(source, { ink: NIGHT.text1, accent: NIGHT.work }));
  const idle = renderLogo(source, FAVICON_COLORS.idle);
  const white = flat(renderLogo(source, { ink: '#ffffff', accent: '#ffffff' }));
  const rasters: Raster[] = [
    { file: `${PUBLIC}favicon.png`, width: 32, height: 32, html: bareHtml(idle, 32) },
    // iOS rounds the corners itself, so the tile runs to the edges.
    {
      file: `${PUBLIC}apple-touch-icon.png`,
      width: 180,
      height: 180,
      html: tileHtml(lit, 180, 'bleed', 0.62),
    },
    {
      file: `${PUBLIC}icon-192.png`,
      width: 192,
      height: 192,
      html: tileHtml(lit, 192, 'rounded', 0.64),
    },
    {
      file: `${PUBLIC}icon-512.png`,
      width: 512,
      height: 512,
      html: tileHtml(lit, 512, 'rounded', 0.64),
    },
    // Maskable icons keep the mark inside the central 80% circle that every mask shape leaves.
    ...[192, 512].map((s) => ({
      file: `${PUBLIC}icon-maskable-${s}.png`,
      width: s,
      height: s,
      html: tileHtml(lit, s, 'bleed', 0.5),
    })),
    // Android's themed icons tint the alpha channel, so a single flat color is all they need.
    {
      file: `${PUBLIC}icon-monochrome-512.png`,
      width: 512,
      height: 512,
      html: `<div id="shot" style="width:512px;height:512px;display:grid;place-items:center">${sized(white, 256)}</div>`,
    },
    {
      file: path('../../extension/media/icon.png'),
      width: 128,
      height: 128,
      html: tileHtml(lit, 128, 'rounded', 0.62),
    },
  ];
  const outputs = [...rasters.map((r) => r.file), `${PUBLIC}favicon.svg`, `${PUBLIC}og-image.png`];
  if (!args.has('--force') && (await upToDate(outputs))) return;

  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    const message = `brand: Chromium unavailable, brand assets not rendered (run \`pnpm exec playwright install chromium\`)`;
    if (args.has('--strict')) throw new Error(message, { cause: err });
    console.warn(message);
    return;
  }
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await write(`${PUBLIC}favicon.svg`, `${idle}\n`);
    for (const raster of rasters) await screenshot(page, fonts, raster);
    const metrics = await measureWordmark(page, fonts);
    await screenshot(page, fonts, {
      file: `${PUBLIC}og-image.png`,
      width: 1200,
      height: 630,
      html: socialHtml(source, metrics),
    });
    let written = rasters.length + 2;

    if (all) {
      await write(`${DOCS}hero-dark.svg`, hero(source, metrics, fonts, NIGHT));
      await write(`${DOCS}hero-light.svg`, hero(source, metrics, fonts, DAY));

      // The brand kit, in logo-designer's seven files (artifacts/, for review only).
      const black = flat(renderLogo(source, { ink: '#0e1116', accent: '#0e1116' }));
      const full = lockup(lit, metrics, 64, NIGHT.text1);
      const kit: Record<string, string> = {
        'logo-mark.svg': `${source.trim()}\n`,
        'logo-full.svg': svgDoc(full.width, full.height, full.body, fonts),
        'logo-wordmark.svg': (() => {
          const w = lockup('', metrics, 64, NIGHT.text1, false);
          return svgDoc(w.width, w.height, w.body, fonts);
        })(),
        'logo-white.svg': (() => {
          const w = lockup(white, metrics, 64, '#ffffff');
          return svgDoc(w.width, w.height, w.body, fonts);
        })(),
        'logo-black.svg': (() => {
          const w = lockup(black, metrics, 64, '#0e1116');
          return svgDoc(w.width, w.height, w.body, fonts);
        })(),
        'favicon.svg': `${idle}\n`,
        'logo-icon.svg': svgDoc(
          512,
          512,
          `<rect width="512" height="512" rx="115" fill="${NIGHT.bg1}"/>${sized(lit, 308).replace('<svg ', '<svg x="102" y="102" ')}`,
        ),
      };
      for (const [name, svg] of Object.entries(kit)) await write(`${KIT}${name}`, svg);
      const sheet = await sheetHtml(source, metrics, fonts);
      await write(
        `${KIT}sheet.html`,
        `<!doctype html><meta charset="utf-8"><title>${BRAND_NAME} brand sheet</title><body style="margin:0">${sheet}</body>`,
      );
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.setContent(
        `<!doctype html><html><head><style>${fontFaces(fonts)}*{box-sizing:border-box}body{margin:0}</style></head><body>${sheet}</body></html>`,
      );
      await page.evaluate(() => document.fonts.ready);
      await page.locator('#shot').screenshot({ path: `${KIT}sheet.png` });
      written += 2 + Object.keys(kit).length + 1;
    }
    console.log(`brand: wrote ${written} assets`);
  } finally {
    await browser.close();
  }
}

await main();
