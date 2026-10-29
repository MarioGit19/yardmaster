import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { type DemoBoard, startBoard } from './board.js';
import { expect, sessionHeader, signedInState, test } from './fixtures.js';
import { connectEditor, OBSERVER_HOOK, PERMISSION_HOOK, runHook } from './local.js';

// The real hook scripts and an editor connection, end to end over the board's socket (synthetic
// session, paths and window).
const SESSION_ID = '5d2c8a1e-7b3f-4c9d-8e6a-1f0b2c3d4e5a';
const CWD = '/home/dev/acme-shop';
const common = {
  session_id: SESSION_ID,
  transcript_path: `/home/dev/.claude/projects/-home-dev-acme-shop/${SESSION_ID}.jsonl`,
  cwd: CWD,
  permission_mode: 'default',
};
const SUGGESTION = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'pnpm test' }],
  behavior: 'allow',
  destination: 'localSettings',
};

let board: DemoBoard;
let token: string;

test.beforeAll(async () => {
  board = await startBoard({ demo: false });
  token = (await readFile(join(board.home, 'token'), 'utf8')).trim();
});

test.afterAll(async () => {
  await board?.stop();
});

test('hooks, terminals and away-mode approvals reach the board through its socket', async ({
  browser,
}) => {
  test.slow();
  const context = await browser.newContext({
    baseURL: board.url,
    storageState: signedInState(board.url, board.session),
  });
  let editor: WebSocket | undefined;
  try {
    const page = await context.newPage();
    await page.goto('/#/');

    // The observer hook posts the session start.
    const started = await runHook(board, OBSERVER_HOOK, {
      ...common,
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect(started).toEqual({ code: 0, stdout: '' });

    // An editor window with a terminal, mirrored like the extension does.
    editor = await connectEditor(board, token, [CWD]);
    editor.send(
      JSON.stringify({
        v: 1,
        type: 'terminal.upsert',
        ts: Date.now(),
        payload: {
          terminalId: 'e2e-terminal-1',
          name: 'e2e dev server',
          shellPid: null,
          cwd: CWD,
          state: 'open',
          shellIntegration: true,
          active: true,
          exitCode: null,
        },
      }),
    );
    await expect(page.locator('a[href^="#/p/"]').first()).toBeVisible();
    const status = await page.request.get('/api/status', { headers: sessionHeader(board.session) });
    expect(await status.json()).toMatchObject({ editors: 1, hooks: { received: 1 } });
    await page.locator('a[href^="#/p/"]').first().click();
    await expect(page.getByText('e2e dev server').first()).toBeVisible();
    await page.goto('/#/');

    // Away mode: the permission hook waits on the board, which decides from the Attention Center.
    const away = await page.request.put('/api/settings', {
      data: { awayMode: true },
      headers: sessionHeader(board.session),
    });
    expect(away.ok()).toBe(true);
    const ask = () => {
      const run = runHook(board, PERMISSION_HOOK, {
        ...common,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        permission_suggestions: [SUGGESTION],
      });
      void run.then(() => {
        exited = true;
      });
      return run;
    };
    let exited = false;
    let decided = ask();
    const waiting = page.locator('[data-hud="waiting"] [data-value]');
    // The hook gives up on the away check after 300 ms, so Claude never waits on a busy board;
    // under a loaded test run that can happen, and the hook rightly exits with no decision.
    await expect
      .poll(
        async () => {
          if (exited) {
            exited = false;
            decided = ask();
          }
          return waiting.getAttribute('data-value');
        },
        { timeout: 20_000 },
      )
      .toBe('1');
    const hud = page.locator('[data-hud="waiting"]');
    await hud.click();
    const sheet = page.getByRole('complementary', { name: /Needs you/ });
    const card = sheet.locator('article[data-approval]').first();
    await expect(card).toContainText('pnpm test');
    await card.getByRole('button', { name: /^Always allow/ }).click();
    await expect(card).toHaveCount(0);

    // The hook printed the decision itself, with Claude Code's own rule, and nothing else.
    const run = await decided;
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: [SUGGESTION] },
      },
    });
  } finally {
    editor?.close();
    await context.close();
  }
});

test('the TCP port refuses the editor and hook channels, even with the token', async ({
  request,
}) => {
  for (const [method, path] of [
    ['POST', '/api/hooks/claude'],
    ['POST', '/api/hooks/permission'],
    ['GET', '/api/away'],
    ['GET', '/ws/editor'],
    ['POST', '/api/local/dashboard-link'],
  ] as const) {
    const res = await request.fetch(`${board.url}${path}`, {
      method,
      headers: { 'x-yardmaster-token': token, 'content-type': 'application/json' },
      data: method === 'POST' ? '{}' : undefined,
    });
    expect(res.status(), path).toBe(403);
    expect(await res.json()).toEqual({ error: 'local_channel_required' });
  }
});
