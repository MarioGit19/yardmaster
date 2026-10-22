import { ansi, clock, type DemoProject, lines } from './content.js';
import type { Rng } from './rng.js';

const { bold, dim, red, green, yellow, cyan, magenta, gray, passBadge, failBadge } = ansi;

export type DevServerKind = 'next' | 'vite' | 'rails';

export interface DevServerScript {
  command: string;
  /** Chunks printed while booting, one every few hundred ms. */
  banner: (port: number) => string[];
  /** One steady-state log chunk. */
  tick: (rng: Rng, ts: number) => string;
  crash: (rng: Rng) => string;
}

const ROUTES = [
  '/',
  '/products',
  '/products/42',
  '/cart',
  '/checkout',
  '/api/cart',
  '/search?q=mug',
];
const API_ROUTES = [
  '/v1/orbits',
  '/v1/orbits/7',
  '/v1/satellites',
  '/v1/health',
  '/v1/launches/12',
];
const MODULES = [
  'src/components/Canvas.tsx',
  'src/components/Toolbar.tsx',
  'src/canvas/viewport.ts',
  'src/layers/stack.ts',
  'src/components/Header.tsx',
  'src/styles/theme.css',
];

const status = (code: number) => (code >= 500 ? red : code >= 400 ? yellow : green)(String(code));

export const DEV_SERVERS: Record<DevServerKind, DevServerScript> = {
  next: {
    command: 'pnpm dev',
    banner: (port) => [
      lines('', `> acme-shop@0.4.0 dev`, `> next dev --turbopack --port ${port}`, ''),
      lines(
        `   ${bold(magenta('▲ Next.js 16.0.1'))} (Turbopack)`,
        `   - Local:        ${cyan(`http://localhost:${port}`)}`,
        '',
        ` ${green('✓')} Starting...`,
      ),
      lines(` ${green('✓')} Ready in 1840ms`),
    ],
    tick: (rng) => {
      const route = rng.pick(ROUTES);
      if (rng.chance(0.25)) {
        return lines(
          ` ${dim('○')} Compiling ${route} ...`,
          ` ${green('✓')} Compiled ${route} in ${rng.int(120, 900)}ms`,
        );
      }
      const code = rng.chance(0.06) ? 404 : 200;
      return lines(` GET ${route} ${status(code)} in ${rng.int(8, 240)}ms`);
    },
    crash: () =>
      lines(
        ` ${red('⨯')} TypeError: Cannot read properties of undefined (reading 'price')`,
        `    at CartTotal (src/components/cart-total.tsx:18:31)`,
        `    at renderWithHooks (node_modules/react-dom/cjs/react-dom-server.node.development.js:5662:16)`,
        ` ${red('⨯')} unhandledRejection: the dev server stopped`,
        red(' ELIFECYCLE  Command failed with exit code 1.'),
      ),
  },
  vite: {
    command: 'pnpm vite',
    banner: (port) => [
      lines(
        '',
        `  ${bold(green('VITE v8.0.3'))}  ${dim('ready in')} ${bold('412')} ${dim('ms')}`,
        '',
      ),
      lines(
        `  ${green('➜')}  ${bold('Local')}:   ${cyan(`http://localhost:${bold(String(port))}/`)}`,
        `  ${green('➜')}  ${dim('press')} ${bold('h + enter')} ${dim('to show help')}`,
      ),
    ],
    tick: (rng, ts) => {
      const mod = rng.pick(MODULES);
      const prefix = `${dim(clock(ts))} ${bold(cyan('[vite]'))}`;
      if (rng.chance(0.15)) return lines(`${prefix} ${green('page reload')} ${dim(mod)}`);
      return lines(`${prefix} ${green('hmr update')} ${dim(`/${mod}`)}`);
    },
    crash: () =>
      lines(
        `${bold(red('[vite] Internal server error:'))} Transform failed with 1 error:`,
        `src/canvas/viewport.ts:42:18: ERROR: Expected ")" but found "{"`,
        `  Plugin: ${magenta('vite:esbuild')}`,
        `  File: src/canvas/viewport.ts:42:18`,
        red('error: the dev server exited unexpectedly'),
      ),
  },
  rails: {
    command: 'bin/rails server',
    banner: (port) => [
      lines(
        '=> Booting Puma',
        '=> Rails 8.1.0 application starting in development',
        '=> Run `bin/rails server --help` for more startup options',
      ),
      lines(
        'Puma starting in single mode...',
        '* Puma version: 7.0.4 ("Romantic Warrior")',
        '*  Environment: development',
        `* Listening on http://127.0.0.1:${port}`,
        'Use Ctrl-C to stop',
      ),
    ],
    tick: (rng, ts) => {
      const route = rng.pick(API_ROUTES);
      const [, , table = 'health', id] = route.split('/');
      const controller = `${capitalize(table)}Controller`;
      const model = capitalize(table.replace(/s$/, ''));
      const sql = id
        ? `SELECT "${table}".* FROM "${table}" WHERE "${table}"."id" = $1 LIMIT $2`
        : `SELECT "${table}".* FROM "${table}" ORDER BY "${table}"."created_at" DESC LIMIT $1`;
      const code = rng.chance(0.05) ? 422 : 200;
      const at = new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
      return lines(
        `Started GET "${route}" for 127.0.0.1 at ${at} +0000`,
        `Processing by ${controller}#${id ? 'show' : 'index'} as JSON`,
        `  ${cyan(`${model} Load (${rng.int(1, 9)}.${rng.int(0, 9)}ms)`)}  ${ansi.blue(sql)}`,
        `Completed ${status(code)} ${code === 200 ? 'OK' : 'Unprocessable Content'} in ${rng.int(4, 80)}ms (Views: 0.${rng.int(1, 9)}ms | ActiveRecord: ${rng.int(1, 12)}.${rng.int(0, 9)}ms)`,
        '',
      );
    },
    crash: () =>
      lines(
        red('ActiveRecord::ConnectionNotEstablished (connection to server on socket failed)'),
        gray("  app/models/orbit.rb:14:in 'Orbit.visible'"),
        gray("  app/controllers/orbits_controller.rb:6:in 'OrbitsController#index'"),
        'Exiting',
      ),
  },
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface TestRun {
  /** Output chunks, printed one per test file. */
  chunks: string[];
  failed: boolean;
}

export function jestRun(rng: Rng, project: DemoProject): TestRun {
  const files = project.testFiles.length > 0 ? project.testFiles : ['src/index.test.ts'];
  const failing = rng.chance(0.2) ? rng.pick(files) : null;
  const chunks: string[] = [];
  let passed = 0;
  for (const file of files) {
    const count = rng.int(3, 12);
    if (file === failing) {
      passed += count - 1;
      chunks.push(
        lines(
          `${failBadge(' FAIL ')} ${dim(file.replace(/[^/]+$/, ''))}${bold(file.split('/').pop() ?? file)}`,
          `  ${red('●')} ${file.split('/').pop()?.replace('.test.ts', '')} › handles the edge case`,
          '',
          `    expect(${red('received')}).toBe(${green('expected')}) ${dim('// Object.is equality')}`,
          '',
          `    Expected: ${green('8.25')}`,
          `    Received: ${red('8.2')}`,
          '',
        ),
      );
    } else {
      passed += count;
      chunks.push(
        lines(
          `${passBadge(' PASS ')} ${dim(file.replace(/[^/]+$/, ''))}${bold(file.split('/').pop() ?? file)}`,
        ),
      );
    }
  }
  const total = failing ? passed + 1 : passed;
  const summary = failing
    ? `${bold(red('1 failed'))}, ${bold(green(`${passed} passed`))}, ${total} total`
    : `${bold(green(`${passed} passed`))}, ${total} total`;
  chunks.push(
    lines(
      `${bold('Test Suites:')} ${failing ? `${bold(red('1 failed'))}, ${bold(green(`${files.length - 1} passed`))}` : bold(green(`${files.length} passed`))}, ${files.length} total`,
      `${bold('Tests:')}       ${summary}`,
      `${bold('Time:')}        ${rng.int(1, 6)}.${rng.int(10, 99)} s`,
      dim('Ran all test suites.'),
    ),
  );
  return { chunks, failed: failing !== null };
}

export interface ShellCommand {
  command: string;
  output: (rng: Rng, project: DemoProject) => string;
  exitCode?: number;
}

export const SHELL_COMMANDS: ShellCommand[] = [
  {
    command: 'git status -sb',
    output: (rng, project) =>
      lines(
        `## ${green(project.branch)}...${red(`origin/${project.branch}`)} [ahead ${rng.int(1, 3)}]`,
        ` ${red('M')} src/${rng.pick(['index.ts', 'config.ts', 'routes.ts'])}`,
        `${red('??')} notes.md`,
      ),
  },
  {
    command: 'git log --oneline -3',
    output: (rng) =>
      lines(
        `${yellow(hex(rng))} ${cyan('(HEAD)')} Tidy up error messages`,
        `${yellow(hex(rng))} Add retry metrics`,
        `${yellow(hex(rng))} Bump dependencies`,
      ),
  },
  {
    command: 'pnpm lint',
    output: (rng) =>
      lines(`Checked ${rng.int(40, 240)} files in ${rng.int(18, 90)}ms. No fixes applied.`),
  },
  {
    command: 'ls',
    output: () =>
      lines(`README.md  ${bold(cyan('docs'))}  package.json  ${bold(cyan('src'))}  tsconfig.json`),
  },
  {
    command: 'pnpm install',
    output: (rng) =>
      lines(
        `Lockfile is up to date, resolution step is skipped`,
        `Already up to date`,
        '',
        `Done in ${rng.int(300, 1900)}ms using pnpm v9.15.9`,
      ),
  },
  {
    command: 'pnpm typecheck',
    output: () =>
      lines(
        `src/config.ts${dim(':')}${yellow('31')}${dim(':')}${yellow('9')} - ${red('error')} ${gray('TS2322:')} Type 'string | undefined' is not assignable to type 'string'.`,
        '',
        `Found 1 error in src/config.ts${gray(':31')}`,
      ),
    exitCode: 2,
  },
];

export function claudeBanner(project: DemoProject, model: string): string {
  return lines(
    '',
    ` ${bold(magenta('✻'))} Welcome to ${bold('Claude Code')}`,
    '',
    `   ${dim('cwd:')} ${project.path}`,
    `   ${dim('model:')} ${model}`,
    '',
  );
}

function hex(rng: Rng): string {
  return rng.hex(7);
}
