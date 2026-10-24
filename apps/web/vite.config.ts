import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { renderLogo } from './src/brand/render.js';
import { migrateStorage } from './src/storage-migration.js';

// The server's Host/Origin checks admit the dev server through YARDMASTER_DEV_ORIGINS,
// which the server's `dev` scripts set to this origin.
const DEV_PORT = 5173;
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
 * Moves browser storage from the old c-board keys (12.7a) in a classic inline script, which runs
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

export default defineConfig({
  plugins: [react(), tailwindcss(), bootMark(), storageMigration()],
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      '/api': { target },
      '/auth': { target },
      '/ws': { target, ws: true },
    },
  },
  // The syntax highlighter worker loads grammars on demand, which needs code splitting.
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    sourcemap: true,
    rolldownOptions: {
      // The push service worker (12.6e3) is served from the root, under a fixed name, so its
      // scope is the whole board.
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        sw: fileURLToPath(new URL('src/push/sw.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
