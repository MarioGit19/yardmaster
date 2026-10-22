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
    // Frame-rate samples run alone, before the parallel suite, so other browsers don't skew them.
    { name: 'perf', testMatch: /crew\.spec\.ts$/ },
    { name: 'e2e', testIgnore: /(shots|crew)\.spec\.ts$/, dependencies: ['perf'] },
    { name: 'shots', testMatch: /shots\.spec\.ts$/ },
  ],
});
