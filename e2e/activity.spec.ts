import type { Page, WebSocketRoute } from '@playwright/test';
import { expect, openRoute, test } from './fixtures.js';

// Activity animation, DESIGN.md §4.10. The board's socket is proxied: the demo's first snapshot
// goes through (with every project's last activity set to "now"), then the live stream is held
// back so the test alone decides what happens and when, on Playwright's fake clock.

test.use({ viewport: { width: 1440, height: 900 } });

interface Board {
  /** Sends a server → UI message to the page. */
  send(type: string, payload: unknown): void;
  projectId(name: string): string;
}

async function frozenBoard(page: Page): Promise<Board> {
  await page.clock.install();
  const projects = new Map<string, string>();
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws\/ui/, (ws) => {
    socket = ws;
    const server = ws.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== 'snapshot') return;
      const now = message.ts;
      for (const project of Object.values(message.payload.state.projects) as {
        id: string;
        name: string;
        lastActivityAt: number | null;
      }[]) {
        project.lastActivityAt = now;
        projects.set(project.name, project.id);
      }
      ws.send(JSON.stringify(message));
    });
  });
  await openRoute(page, '/');
  return {
    send(type, payload) {
      socket?.send(JSON.stringify({ v: 1, type, ts: Date.now(), payload }));
    },
    projectId(name) {
      const id = projects.get(name);
      if (!id) throw new Error(`no demo project named ${name}`);
      return id;
    },
  };
}

const pod = (page: Page, id: string) => page.locator(`[data-pod="${id}"]`);

test('a finished turn sweeps its pod once', async ({ page }) => {
  const board = await frozenBoard(page);
  const id = board.projectId('acme-shop');
  await expect(pod(page, id)).toBeVisible();
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1_000);
  const ts = await page.evaluate(() => Date.now());

  const stop = {
    id: 'e2e-stop-1',
    ts,
    kind: 'stop',
    projectId: id,
    sessionId: null,
    terminalId: null,
    execId: null,
    summary: 'Turn finished',
    data: {},
  };
  board.send('activity', { events: [stop], replace: false });
  await expect(pod(page, id).locator('[data-done-sweep]')).toBeAttached();
  await expect(pod(page, id)).toHaveAttribute('data-sweeps', '1');
  await expect(page.locator('[data-done-sweep]')).toHaveCount(1);

  await page.clock.runFor(1_000);
  await expect(pod(page, id).locator('[data-done-sweep]')).toHaveCount(0);

  // The same event again (a replay) and more time: still one sweep.
  board.send('activity', { events: [stop], replace: false });
  await page.clock.runFor(2_000);
  await expect(pod(page, id).locator('[data-done-sweep]')).toHaveCount(0);
  await expect(pod(page, id)).toHaveAttribute('data-sweeps', '1');
});

test('quiet pods dim after five minutes', async ({ page }) => {
  const board = await frozenBoard(page);
  const id = board.projectId('field-notes');
  await expect(pod(page, id)).toBeVisible();
  await expect(pod(page, id)).not.toHaveAttribute('data-dim');
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1_000);

  await page.clock.fastForward('04:00');
  await expect(pod(page, id)).not.toHaveAttribute('data-dim');
  await page.clock.fastForward('01:20');
  await expect(pod(page, id)).toHaveAttribute('data-dim', 'true');
  // The fade is a CSS transition, whose timeline the fake clock doesn't drive: jump to the end.
  await page.clock.runFor(100);
  await pod(page, id).evaluate((el) => {
    for (const animation of el.getAnimations({ subtree: true })) {
      if (animation instanceof CSSTransition) animation.finish();
    }
  });
  // Only the non-text layers step back; the pod and its text keep full contrast.
  const opacity = (selector: string) =>
    pod(page, id)
      .locator(selector)
      .first()
      .evaluate((el) => getComputedStyle(el).opacity);
  await expect(pod(page, id)).toHaveAttribute('data-pod-form', 'row');
  await expect.poll(() => opacity('.pod-dim')).toBe('0.7');
  await expect.poll(() => pod(page, id).evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  expect(await opacity('header a')).toBe('1');

  // A pod that needs you never dims, however long it waits.
  for (const tone of ['wait', 'err', 'work']) {
    await expect(page.locator(`[data-pod][data-tone="${tone}"][data-dim]`)).toHaveCount(0);
  }
  await expect(page.locator('[data-pod][data-crashed][data-dim]')).toHaveCount(0);
});

test('Reduced shows activity without movement', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'reduced'));
  await openRoute(page, '/');
  await expect(page.locator('[data-pod]').first()).toBeVisible();
  // Let the live demo produce events and output.
  await page.waitForTimeout(3_000);
  await expect(page.locator('[data-activity-border="spin"]')).toHaveCount(0);
  await expect(page.locator('[data-activity-border="still"]').first()).toBeAttached();
  await expect(page.locator('.pod-spark')).toHaveCount(0);

  const moving = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.playState === 'running')
      .flatMap((animation) => {
        const effect = animation.effect as KeyframeEffect | null;
        const frames = effect?.getKeyframes() ?? [];
        const moves = frames.some((frame) =>
          ['transform', 'translate', 'rotate', 'scale'].some(
            (property) => property in frame && frame[property] !== 'none',
          ),
        );
        const name = (animation as CSSAnimation).animationName ?? animation.id;
        return moves ? [name || 'unnamed'] : [];
      }),
  );
  expect(moving).toEqual([]);
});
