import { defineConfig, devices } from '@playwright/test';

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
  projects: [
    // Frame-rate and long-task checks run alone, one after the other, before the parallel suite.
    { name: 'perf', testMatch: /crew\.spec\.ts$/ },
    // The transcript tests scroll hundreds of rows and highlight code in a worker: alone, in order.
    {
      name: 'perf-messages',
      testMatch: /messages\.spec\.ts$/,
      fullyParallel: false,
      dependencies: ['perf'],
    },
    // The PRD §9 load (`--demo-stress`). Full Chromium (new headless) renders with the GPU; the
    // headless shell falls back to software WebGL, which says nothing about the target machine.
    // It runs after the transcript checks: its GPU browser's teardown would land in their window.
    {
      name: 'perf-stress',
      testMatch: /stress\.spec\.ts$/,
      fullyParallel: false,
      use: { channel: 'chromium' },
      dependencies: ['perf-messages'],
    },
    {
      name: 'e2e',
      testIgnore: /(shots|crew|stress|messages)\.spec\.ts$/,
      dependencies: ['perf-stress'],
    },
    { name: 'shots', testMatch: /shots\.spec\.ts$/ },
  ],
});
