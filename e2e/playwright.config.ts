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
    // The transcript tests scroll hundreds of rows and highlight code in a worker: alone, in order,
    // on the GPU, as the stress check below: the headless shell rasters in software, and under
    // load its compositor stalls the main thread for 50+ ms commits that no script caused.
    {
      name: 'perf-messages',
      testMatch: /messages\.spec\.ts$/,
      fullyParallel: false,
      use: { channel: 'chromium' },
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
      grepInvert: /@webgl/,
      dependencies: ['perf-stress'],
    },
    // Tests tagged `WEBGL` (fixtures.ts) need a WebGL context, so they get the GPU, two at a time:
    // the headless shell's software WebGL fails context creation under the parallel suite's load.
    {
      name: 'e2e-webgl',
      testIgnore: /(shots|crew|stress|messages)\.spec\.ts$/,
      grep: /@webgl/,
      use: { channel: 'chromium' },
      workers: 2,
      dependencies: ['perf-stress'],
    },
    { name: 'shots', testMatch: /shots\.spec\.ts$/ },
  ],
});
