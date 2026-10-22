// Bundles the extension into one CommonJS file. `vscode` is provided by the editor at runtime.
// Usage: node scripts/build.mjs [--production]
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const production = process.argv.includes('--production');
const root = fileURLToPath(new URL('..', import.meta.url));

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // VS Code 1.93 ships Electron 30 (Node 20).
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'warning',
});
