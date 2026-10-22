// Synthetic demo content. Every path, name and log line here is made up.

export type TerminalKind = 'next' | 'vite' | 'rails' | 'jest' | 'shell' | 'claude';

export interface DemoTool {
  tool: string;
  summary: string;
}

export interface DemoPermission {
  tool: string;
  input: Record<string, unknown>;
}

export interface DemoScenario {
  title: string;
  prompt: string;
  todos: string[];
  tools: DemoTool[];
  texts: string[];
  permissions: DemoPermission[];
}

export interface DemoTerminal {
  kind: TerminalKind;
  name: string;
  port?: number;
}

export interface DemoProject {
  name: string;
  path: string;
  branch: string;
  /** Index into `DEMO_WINDOWS`. */
  window: number;
  terminals: DemoTerminal[];
  testFiles: string[];
  scenarios: DemoScenario[];
}

export const DEMO_HOME = '/home/dev';

export const DEMO_WINDOWS = [
  { appName: 'Cursor', appVersion: '2.1.4' },
  { appName: 'Cursor', appVersion: '2.1.4' },
  { appName: 'Visual Studio Code', appVersion: '1.105.0' },
  { appName: 'Cursor', appVersion: '2.1.4' },
] as const;

export const DEMO_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'] as const;

export const DEMO_PROJECTS: DemoProject[] = [
  {
    name: 'acme-shop',
    path: `${DEMO_HOME}/acme-shop`,
    branch: 'feat/cart-discounts',
    window: 0,
    terminals: [
      { kind: 'next', name: 'next dev', port: 3000 },
      { kind: 'jest', name: 'tests' },
      { kind: 'shell', name: 'zsh' },
      { kind: 'claude', name: 'claude' },
    ],
    testFiles: [
      'src/cart/total.test.ts',
      'src/cart/discount.test.ts',
      'src/checkout/tax.test.ts',
      'src/catalog/search.test.ts',
    ],
    scenarios: [
      {
        title: 'Stack percentage and fixed discounts in the cart',
        prompt: 'Discount codes should stack: percentage first, then fixed amounts.',
        todos: [
          'Read the current discount pipeline',
          'Apply percentage codes before fixed codes',
          'Update cart total tests',
          'Run the test suite',
        ],
        tools: [
          { tool: 'Read', summary: 'src/cart/discount.ts' },
          { tool: 'Grep', summary: '"applyDiscount"' },
          { tool: 'Edit', summary: 'src/cart/discount.ts' },
          { tool: 'Edit', summary: 'src/cart/total.test.ts' },
          { tool: 'Bash', summary: 'pnpm jest src/cart' },
          { tool: 'Task', summary: 'Find every caller of cartTotal' },
        ],
        texts: [
          'The discount pipeline applies codes in insertion order, so a fixed code entered first gets scaled by the percentage code after it. I will sort codes by kind before reducing.',
          'Both cart tests pass now. I also added a case for two percentage codes, which compound rather than add.',
        ],
        permissions: [
          { tool: 'Bash', input: { command: 'pnpm prisma migrate dev --name discount-kind' } },
          { tool: 'Write', input: { file_path: `${DEMO_HOME}/acme-shop/src/cart/stacking.ts` } },
        ],
      },
      {
        title: 'Fix the checkout tax rounding',
        prompt: 'Tax on the checkout page is off by a cent for some regions.',
        todos: [
          'Reproduce the rounding error',
          'Round per line item instead of on the total',
          'Add a regression test',
        ],
        tools: [
          { tool: 'Read', summary: 'src/checkout/tax.ts' },
          { tool: 'Bash', summary: 'pnpm jest src/checkout/tax' },
          { tool: 'Edit', summary: 'src/checkout/tax.ts' },
          { tool: 'Glob', summary: 'src/checkout/**/*.test.ts' },
        ],
        texts: [
          'The total is rounded once at the end, but the invoice rounds each line. That disagreement is where the cent goes missing.',
          'Tax is now rounded per line with banker’s rounding, matching the invoice service.',
        ],
        permissions: [{ tool: 'Bash', input: { command: 'pnpm jest --updateSnapshot' } }],
      },
    ],
  },
  {
    name: 'orbit-api',
    path: `${DEMO_HOME}/orbit-api`,
    branch: 'main',
    window: 1,
    terminals: [
      { kind: 'rails', name: 'server', port: 3001 },
      { kind: 'shell', name: 'zsh' },
      { kind: 'claude', name: 'claude' },
    ],
    testFiles: [],
    scenarios: [
      {
        title: 'Paginate the orbits index endpoint',
        prompt: 'GET /v1/orbits returns everything at once. Add cursor pagination.',
        todos: [
          'Add a cursor param to OrbitsController#index',
          'Return a next_cursor in the response',
          'Document the new params',
        ],
        tools: [
          { tool: 'Read', summary: 'app/controllers/orbits_controller.rb' },
          { tool: 'Edit', summary: 'app/controllers/orbits_controller.rb' },
          { tool: 'Bash', summary: 'bin/rails test test/controllers' },
          { tool: 'WebFetch', summary: 'api.rubyonrails.org/ActiveRecord' },
          { tool: 'Edit', summary: 'docs/api/orbits.md' },
        ],
        texts: [
          'I will use keyset pagination on (created_at, id) so pages stay stable while new orbits are inserted.',
          'The endpoint now returns at most 50 orbits plus a next_cursor. Controller tests cover the first, middle and last page.',
        ],
        permissions: [
          { tool: 'Bash', input: { command: 'bin/rails db:migrate' } },
          { tool: 'Bash', input: { command: 'bundle add pagy' } },
        ],
      },
    ],
  },
  {
    name: 'pixel-studio',
    path: `${DEMO_HOME}/pixel-studio`,
    branch: 'canvas-zoom',
    window: 2,
    terminals: [
      { kind: 'vite', name: 'vite', port: 5173 },
      { kind: 'jest', name: 'tests' },
      { kind: 'shell', name: 'zsh' },
      { kind: 'claude', name: 'claude' },
      { kind: 'claude', name: 'claude · review' },
    ],
    testFiles: ['src/canvas/zoom.test.ts', 'src/canvas/brush.test.ts', 'src/layers/stack.test.ts'],
    scenarios: [
      {
        title: 'Pinch-to-zoom around the cursor',
        prompt: 'Zoom should keep the point under the cursor fixed, like Figma.',
        todos: [
          'Find the zoom handler',
          'Convert the pointer to canvas space before scaling',
          'Clamp zoom to 5%–3200%',
          'Test the transform math',
        ],
        tools: [
          { tool: 'Grep', summary: '"onWheel"' },
          { tool: 'Read', summary: 'src/canvas/viewport.ts' },
          { tool: 'Edit', summary: 'src/canvas/viewport.ts' },
          { tool: 'Edit', summary: 'src/canvas/zoom.test.ts' },
          { tool: 'Bash', summary: 'pnpm jest src/canvas' },
          { tool: 'Task', summary: 'Review the viewport transform' },
        ],
        texts: [
          'The handler scales around the canvas origin. I will translate by the pointer position, scale, then translate back.',
          'Zoom now anchors at the cursor and is clamped. The transform tests cover both trackpad pinch and the wheel.',
        ],
        permissions: [{ tool: 'Bash', input: { command: 'pnpm add -D @types/offscreencanvas' } }],
      },
      {
        title: 'Review the layer stack refactor',
        prompt: 'Review the diff on this branch and flag anything risky.',
        todos: ['Read the diff', 'Check undo history still works', 'Write up findings'],
        tools: [
          { tool: 'Bash', summary: 'git diff main --stat' },
          { tool: 'Read', summary: 'src/layers/stack.ts' },
          { tool: 'Read', summary: 'src/history/undo.ts' },
          { tool: 'Grep', summary: '"layers.splice"' },
        ],
        texts: [
          'The refactor moves layers into an immutable array, but undo still stores indexes into the old mutable one.',
          'One real issue: reordering two layers and undoing restores the wrong one. Everything else looks fine.',
        ],
        permissions: [{ tool: 'Bash', input: { command: 'git stash push -m review' } }],
      },
    ],
  },
  {
    name: 'ledger-sync',
    path: `${DEMO_HOME}/ledger-sync`,
    branch: 'fix/retry-backoff',
    window: 3,
    terminals: [
      { kind: 'jest', name: 'tests' },
      { kind: 'shell', name: 'zsh' },
      { kind: 'claude', name: 'claude' },
    ],
    testFiles: ['src/sync/retry.test.ts', 'src/sync/batch.test.ts', 'src/ledger/parse.test.ts'],
    scenarios: [
      {
        title: 'Exponential backoff for failed sync batches',
        prompt:
          'Failed batches retry immediately and hammer the bank API. Add backoff with jitter.',
        todos: [
          'Find the retry loop',
          'Add exponential backoff with full jitter',
          'Cap retries at 6',
          'Cover it with fake-timer tests',
        ],
        tools: [
          { tool: 'Read', summary: 'src/sync/retry.ts' },
          { tool: 'Edit', summary: 'src/sync/retry.ts' },
          { tool: 'Edit', summary: 'src/sync/retry.test.ts' },
          { tool: 'Bash', summary: 'pnpm jest src/sync' },
          { tool: 'WebSearch', summary: 'exponential backoff full jitter' },
        ],
        texts: [
          'The retry loop has no delay at all. I will use full jitter: sleep a random time between 0 and min(cap, base·2^attempt).',
          'Retries now back off up to 30 s and give up after six attempts, logging the batch id.',
        ],
        permissions: [{ tool: 'Bash', input: { command: 'pnpm jest --runInBand' } }],
      },
    ],
  },
  {
    name: 'docs-site',
    path: `${DEMO_HOME}/docs-site`,
    branch: 'main',
    window: 2,
    terminals: [
      { kind: 'vite', name: 'docs dev', port: 5174 },
      { kind: 'claude', name: 'claude' },
    ],
    testFiles: [],
    scenarios: [
      {
        title: 'Add a search shortcut to the docs header',
        prompt: 'Pressing / should focus the search box, unless you are typing in an input.',
        todos: ['Add the keydown listener', 'Ignore editable targets', 'Show the hint in the box'],
        tools: [
          { tool: 'Read', summary: 'src/components/Header.tsx' },
          { tool: 'Edit', summary: 'src/components/Header.tsx' },
          { tool: 'Edit', summary: 'src/components/SearchBox.tsx' },
          { tool: 'Bash', summary: 'pnpm build' },
        ],
        texts: [
          'I will listen on the document and skip events whose target is an input, textarea or contenteditable.',
          'Pressing / now focuses search, and the box shows a small "/" hint until it is focused.',
        ],
        permissions: [{ tool: 'Bash', input: { command: 'pnpm build && pnpm preview' } }],
      },
    ],
  },
];

// ANSI helpers. Output is shown in xterm, so lines end with CRLF.

const sgr = (open: string, close: string) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;
export const ansi = {
  bold: sgr('1', '22'),
  dim: sgr('2', '22'),
  red: sgr('31', '39'),
  green: sgr('32', '39'),
  yellow: sgr('33', '39'),
  blue: sgr('34', '39'),
  magenta: sgr('35', '39'),
  cyan: sgr('36', '39'),
  gray: sgr('90', '39'),
  passBadge: sgr('42;30;1', '0'),
  failBadge: sgr('41;37;1', '0'),
};

export const lines = (...rows: string[]): string => rows.map((row) => `${row}\r\n`).join('');

/** `HH:MM:SS`, UTC so output doesn't depend on the machine's zone. */
export const clock = (ts: number): string => new Date(ts).toISOString().slice(11, 19);

/** Changed-file pool for the git panel, beyond each project's test files. */
export const DEMO_CHANGED_FILES = [
  'src/index.ts',
  'README.md',
  'src/lib/format.ts',
  'package.json',
  'src/config.ts',
  'docs/notes.md',
] as const;

export const DEMO_COMMITS = [
  { author: 'Robin Vale', subject: 'Tighten error handling in the sync loop' },
  { author: 'Sam Ortiz', subject: 'Bump dev dependencies' },
  { author: 'Robin Vale', subject: 'Add tests for edge-case inputs' },
  { author: 'Kai Mendel', subject: 'Refactor config loading' },
  { author: 'Sam Ortiz', subject: 'Fix flaky timer in CI' },
  { author: 'Kai Mendel', subject: 'Document the release steps' },
  { author: 'Robin Vale', subject: 'Initial scaffold' },
] as const;
