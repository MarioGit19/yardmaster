// Renders the PNG brand assets from src/brand/logo.svg with headless Chromium.
// Usage: tsx scripts/render-icons.ts [--force] [--strict]
//   --force   re-render even when the PNGs are newer than their sources
//   --strict  fail instead of warning when Chromium can't be launched
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { renderLogo } from '../src/brand/render.js';

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const LOGO = path('../src/brand/logo.svg');
const SOURCES = [LOGO, path('../src/brand/render.ts'), fileURLToPath(import.meta.url)];
const BG = '#05060a';

interface Icon {
  file: string;
  size: number;
  /** Solid backdrop for platforms that don't keep transparency (iOS home screen). */
  background?: string;
}

const ICONS: Icon[] = [
  { file: path('../public/favicon.png'), size: 32 },
  { file: path('../public/apple-touch-icon.png'), size: 180, background: BG },
  { file: path('../../extension/media/icon.png'), size: 128 },
];

async function mtime(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function upToDate(): Promise<boolean> {
  const newestSource = Math.max(...(await Promise.all(SOURCES.map(mtime))));
  const outputs = await Promise.all(ICONS.map((icon) => mtime(icon.file)));
  return outputs.every((t) => t > newestSource);
}

function iconHtml(svg: string, icon: Icon): string {
  const pad = icon.background ? Math.round(icon.size * 0.14) : 0;
  return `<!doctype html><html><body style="margin:0;background:transparent">
<div id="icon" style="width:${icon.size}px;height:${icon.size}px;box-sizing:border-box;padding:${pad}px;background:${icon.background ?? 'transparent'}">
${svg.replace('<svg ', '<svg width="100%" height="100%" ')}
</div></body></html>`;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (!args.has('--force') && (await upToDate())) return;

  // Night idle colors: a light ring and the work-blue orb read on light and dark chrome.
  const svg = renderLogo(await readFile(LOGO, 'utf8'), { ring: '#a3a9b8', accent: '#7c9cff' });

  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch();
  } catch (err) {
    const message = `render-icons: Chromium unavailable, PNG icons not rendered (run \`pnpm exec playwright install chromium\`)`;
    if (args.has('--strict')) throw new Error(message, { cause: err });
    console.warn(message);
    return;
  }
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const icon of ICONS) {
      await page.setViewportSize({ width: icon.size, height: icon.size });
      await page.setContent(iconHtml(svg, icon));
      await mkdir(dirname(icon.file), { recursive: true });
      await page.locator('#icon').screenshot({ path: icon.file, omitBackground: true });
    }
  } finally {
    await browser.close();
  }
  console.log(`render-icons: wrote ${ICONS.length} icons`);
}

await main();
