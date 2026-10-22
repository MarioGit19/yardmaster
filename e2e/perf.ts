import type { Page } from '@playwright/test';

export interface MainThread {
  /** Milliseconds of main-thread work per second of wall clock. */
  task: number;
  script: number;
  style: number;
  layout: number;
}

/**
 * Chromium's own main-thread counters (what a Performance trace sums up) over `ms`, per second.
 * Chromium only; the page must stay open for the whole window.
 */
export async function mainThread(page: Page, ms: number): Promise<MainThread> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const read = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const value = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
    return {
      task: value('TaskDuration'),
      script: value('ScriptDuration'),
      style: value('RecalcStyleDuration'),
      layout: value('LayoutDuration'),
    };
  };
  const before = await read();
  await page.waitForTimeout(ms);
  const after = await read();
  await cdp.detach();
  const perSecond = (key: keyof MainThread) => ((after[key] - before[key]) * 1e6) / ms;
  return {
    task: perSecond('task'),
    script: perSecond('script'),
    style: perSecond('style'),
    layout: perSecond('layout'),
  };
}

export function formatMainThread(stats: MainThread): string {
  const ms = (v: number) => v.toFixed(0);
  return (
    `${ms(stats.task)} ms/s busy (script ${ms(stats.script)}, style ${ms(stats.style)}, ` +
    `layout ${ms(stats.layout)})`
  );
}
