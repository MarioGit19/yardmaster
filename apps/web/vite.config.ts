import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build, defineConfig, type Plugin } from 'vite';
import { renderLogo } from './src/brand/render.js';
import { migrateStorage } from './src/storage-migration.js';

// The server's Host/Origin checks admit the dev server through YARDMASTER_DEV_ORIGINS,
// which the server's `dev` scripts set to this origin. An unusual fixed port: the board's
// session lives in this origin's storage, which another project's dev server must never share.
const DEV_PORT = 4327;
// CBOARD_PORT is the name from before the rename.
const serverPort = Number(process.env.YARDMASTER_PORT || process.env.CBOARD_PORT) || 4317;
const target = `http://127.0.0.1:${serverPort}`;

/**
 * The loading state before the app's script runs: the still logomark, centered and dimmed, drawn
 * from `logo.svg`. React replaces it on its first render.
 */
function bootMark(): Plugin {
  const source = fileURLToPath(new URL('src/brand/logo.svg', import.meta.url));
  return {
    name: 'boot-mark',
    transformIndexHtml(html) {
      const svg = renderLogo(readFileSync(source, 'utf8'), { ink: '#787e90', accent: '#7c9cff' })
        .replace('<svg ', '<svg width="40" height="40" ')
        .replace(/\s*\n\s*/g, '');
      return html.replace(
        '<!--boot-mark-->',
        `<div data-boot-mark style="position:fixed;inset:0;display:grid;place-items:center;opacity:.5">${svg}</div>`,
      );
    },
  };
}

/**
 * Moves browser storage from the old c-board keys in a classic inline script, which runs
 * before the app's modules. A module can't: shared chunks run before the entry's own code.
 */
function storageMigration(): Plugin {
  return {
    name: 'storage-migration',
    transformIndexHtml: (html) =>
      html.replace(
        '<!--storage-migration-->',
        `<script>(${migrateStorage.toString()})(window)</script>`,
      ),
  };
}

/**
 * The push service worker (`/sw.js`), built on its own into one classic script after the app: a
 * module it shared with the app (the session's IndexedDB copy) would otherwise land in a shared
 * chunk, and a classic worker can't import it. Served from the root, so its scope is the board.
 */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    async closeBundle() {
      await build({
        configFile: false,
        logLevel: 'warn',
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          target: 'es2023',
          sourcemap: true,
          lib: {
            entry: fileURLToPath(new URL('src/push/sw.ts', import.meta.url)),
            formats: ['iife'],
            name: 'yardmasterServiceWorker',
            fileName: () => 'sw.js',
          },
        },
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), bootMark(), storageMigration(), serviceWorker()],
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      '/api': { target },
      '/auth': { target },
      '/pair': { target },
      '/ws': { target, ws: true },
    },
  },
  // The syntax highlighter worker loads grammars on demand, which needs code splitting.
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
