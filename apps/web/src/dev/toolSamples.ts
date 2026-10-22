import type { ToolRow } from '../claude/transcript.js';

// Synthetic tool calls for the /_tokens showcase and tests: one per card variant, plus the
// running and failed states. Every path and name here is made up.

export const SAMPLE_CWD = '/home/dev/acme-shop';

let n = 0;
function tool(
  name: string,
  input: unknown,
  result: { text: string; isError?: boolean } | null,
): ToolRow {
  n++;
  return {
    kind: 'tool',
    id: `sample-${n}:0`,
    ts: null,
    toolUseId: `toolu_sample_${n}`,
    name,
    input,
    result: result && { text: result.text, isError: result.isError ?? false },
  };
}

const numbered = (lines: string[], first = 1) =>
  lines.map((line, i) => `${String(first + i).padStart(6)}\t${line}`).join('\n');

const DISCOUNT_AFTER = [
  'export function applyAll(items: readonly Item[], rules: readonly Rule[]): number {',
  '  const ordered = [...rules].sort((a, b) => rank(a) - rank(b));',
  '  // Percentages first, so fixed amounts are never scaled.',
  '  return ordered.reduce((total, rule) => rule.apply(total), subtotal(items));',
  '}',
];

export const TOOL_SAMPLES: { label: string; row: ToolRow }[] = [
  {
    label: 'Bash',
    row: tool(
      'Bash',
      { command: 'pnpm vitest run src/cart', description: 'Run the cart tests' },
      {
        text: ' ✓ src/cart/total.test.ts (12 tests) 18ms\n ✓ src/cart/discount.test.ts (9 tests) 11ms\n\n Test Files  2 passed (2)\n      Tests  21 passed (21)\n   Duration  1.24s',
      },
    ),
  },
  {
    label: 'Bash, failed',
    row: tool(
      'Bash',
      { command: 'pnpm vitest run src/checkout/tax' },
      {
        text: 'Exit code 1\n FAIL  src/checkout/tax.test.ts > rounds per line\n  AssertionError: expected 1799 to be 1800\n\n Tests  1 failed | 14 passed (15)',
        isError: true,
      },
    ),
  },
  {
    label: 'Bash, running',
    row: tool('Bash', { command: 'pnpm build && pnpm preview', run_in_background: true }, null),
  },
  {
    label: 'Edit',
    row: tool(
      'Edit',
      {
        file_path: `${SAMPLE_CWD}/src/cart/discount.ts`,
        old_string: [
          'export function applyAll(items: readonly Item[], rules: readonly Rule[]): number {',
          '  return rules.reduce((total, rule) => rule.apply(total), subtotal(items));',
          '}',
        ].join('\n'),
        new_string: DISCOUNT_AFTER.join('\n'),
      },
      {
        text: `The file ${SAMPLE_CWD}/src/cart/discount.ts has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:\n${numbered(DISCOUNT_AFTER, 41)}`,
      },
    ),
  },
  {
    label: 'MultiEdit',
    row: tool(
      'MultiEdit',
      {
        file_path: `${SAMPLE_CWD}/src/sync/retry.ts`,
        edits: [
          {
            old_string: 'const MAX_RETRIES = 3;\nconst BASE_DELAY_MS = 200;',
            new_string:
              'const MAX_RETRIES = 5;\nconst BASE_DELAY_MS = 250;\nconst MAX_DELAY_MS = 8_000;',
          },
          {
            old_string: '  return BASE_DELAY_MS * 2 ** attempt;',
            new_string:
              '  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);\n  return Math.random() * cap;',
          },
        ],
      },
      { text: `Applied 2 edits to ${SAMPLE_CWD}/src/sync/retry.ts` },
    ),
  },
  {
    label: 'Write',
    row: tool(
      'Write',
      {
        file_path: `${SAMPLE_CWD}/src/cart/stacking.ts`,
        content:
          "import type { Rule } from './rules';\n\n/** Percentage rules go first, then fixed amounts. */\nexport function rank(rule: Rule): number {\n  return rule.kind === 'percent' ? 0 : 1;\n}\n",
      },
      { text: `File created successfully at: ${SAMPLE_CWD}/src/cart/stacking.ts` },
    ),
  },
  {
    label: 'Read',
    row: tool(
      'Read',
      { file_path: `${SAMPLE_CWD}/src/cart/discount.ts` },
      { text: numbered(DISCOUNT_AFTER) },
    ),
  },
  {
    label: 'Grep',
    row: tool(
      'Grep',
      { pattern: 'applyDiscount', path: SAMPLE_CWD, glob: 'src/**/*.ts' },
      {
        text: `Found 3 files\n${SAMPLE_CWD}/src/cart/discount.ts\n${SAMPLE_CWD}/src/cart/total.ts\n${SAMPLE_CWD}/src/checkout/summary.ts`,
      },
    ),
  },
  {
    label: 'Glob',
    row: tool(
      'Glob',
      { pattern: 'src/checkout/**/*.test.ts' },
      {
        text: `${SAMPLE_CWD}/src/checkout/tax.test.ts\n${SAMPLE_CWD}/src/checkout/summary.test.ts`,
      },
    ),
  },
  {
    label: 'TodoWrite',
    row: tool(
      'TodoWrite',
      {
        todos: [
          {
            content: 'Read the current discount pipeline',
            status: 'completed',
            activeForm: 'Reading the pipeline',
          },
          {
            content: 'Apply percentage codes before fixed codes',
            status: 'completed',
            activeForm: 'Reordering the codes',
          },
          {
            content: 'Update cart total tests',
            status: 'in_progress',
            activeForm: 'Updating the cart tests',
          },
          { content: 'Run the test suite', status: 'pending', activeForm: 'Running the tests' },
        ],
      },
      { text: 'Todos have been modified successfully.' },
    ),
  },
  {
    label: 'Task',
    row: tool(
      'Task',
      {
        description: 'Find every caller of cartTotal',
        prompt:
          'Find every caller of cartTotal in src/. Report file paths with line numbers and a one-line note for each, and say if anything looks unsafe to change.',
        subagent_type: 'Explore',
      },
      {
        text: 'Found 3 callers:\n\n- `src/checkout/summary.ts:28`: renders the total\n- `src/cart/total.ts:12`: the helper itself\n- `src/api/orders.ts:61`: stores it on the order\n\nNothing looks unsafe to change.',
      },
    ),
  },
  {
    label: 'WebFetch',
    row: tool(
      'WebFetch',
      {
        url: 'https://docs.example.org/guides/retries#backoff',
        prompt: 'Summarise the backoff section',
      },
      {
        text: 'The guide recommends **full jitter**: wait a random time between 0 and the capped exponential delay.',
      },
    ),
  },
  {
    label: 'WebSearch',
    row: tool(
      'WebSearch',
      { query: 'exponential backoff full jitter' },
      {
        text: 'Web search results for query: "exponential backoff full jitter"\n\nLinks: [{"title":"Backoff compared","url":"https://example.com/blog/backoff"},{"title":"Retry guide","url":"https://docs.example.org/guides/retries"}]\n\nFull jitter spreads retries evenly across the window.',
      },
    ),
  },
  {
    label: 'Unknown tool',
    row: tool(
      'mcp__tracker__create_ticket',
      { title: 'Stack percentage and fixed discounts', labels: ['cart'], priority: 'medium' },
      { text: 'Created ticket TRK-142' },
    ),
  },
];
