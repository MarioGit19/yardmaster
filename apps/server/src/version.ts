import { readFileSync } from 'node:fs';

// Resolves from both src/ (tsx, vitest) and dist/ (built).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const VERSION: string = pkg.version;
