// Bundles the server CLI into dist/cli.js (plus the deprecated dist/c-board.js alias), with the
// workspace packages inlined from their sources, so `node dist/cli.js` needs no export condition.
// The web app is served from apps/web/dist and the hook script from packages/hook/bin.
// Usage: node scripts/build.mjs
import { chmod, readFile, rm } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = fileURLToPath(new URL('../../..', import.meta.url));
const outdir = fileURLToPath(new URL('../dist', import.meta.url));

// Our modules find files next to themselves (`../package.json`, `../../web/dist`, `../bin/…`).
// Inside the bundle, `import.meta.url` is the bundle's, so each one gets its own back, made
// relative to dist/ so the build keeps working when the repo is copied or packed.
const ownUrls = {
  name: 'own-import-meta-url',
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, async (args) => {
      if (!args.path.startsWith(repo) || args.path.includes('/node_modules/')) return undefined;
      const source = await readFile(args.path, 'utf8');
      if (!source.includes('import.meta.url')) return undefined;
      const rel = relative(outdir, args.path).split('\\').join('/');
      return {
        contents: source.replaceAll(
          'import.meta.url',
          `new URL(${JSON.stringify(rel)}, import.meta.url).href`,
        ),
        loader: 'ts',
        resolveDir: dirname(args.path),
      };
    });
  },
};

const shared = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  logLevel: 'warning',
};

await rm(outdir, { recursive: true, force: true });
await build({
  ...shared,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  plugins: [ownUrls],
  // node-pty is native and optional; the Agent SDK runs Claude Code from its own package files;
  // ws falls back to plain JS without its optional native helpers.
  external: ['node-pty', '@anthropic-ai/claude-agent-sdk', 'bufferutil', 'utf-8-validate'],
  // CommonJS dependencies (fastify, pino) call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __yardmasterRequire } from 'node:module';\nconst require = __yardmasterRequire(import.meta.url);",
  },
});
await build({
  ...shared,
  entryPoints: ['src/c-board.ts'],
  outfile: 'dist/c-board.js',
  external: ['./cli.js'],
});
await Promise.all([chmod(`${outdir}/cli.js`, 0o755), chmod(`${outdir}/c-board.js`, 0o755)]);
