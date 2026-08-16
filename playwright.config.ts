import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false, // Tests share state (DB), run sequentially
  forbidOnly: !!process.env.CI,
  // Shared CI runners are slower and noisier than a dev machine, and this
  // suite drives real WebRTC, a WASM crypto engine and a mail transport. Two
  // retries keeps a merge-blocking gate honest about genuine breakage without
  // failing PRs on runner jitter; locally, a failure is a failure.
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'html',
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://localhost:8080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    permissions: ['microphone'],
  },

  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
  ],

  webServer: [
    {
      command: 'pnpm dev:server',
      url: 'http://localhost:3001/health',
      // Locally, attach to whatever dev stack is already running. In CI there
      // is nothing to reuse, and silently attaching to a stale process would
      // test the wrong build.
      reuseExistingServer: !process.env.CI,
      // Cold start in CI compiles TypeScript through tsx and warms Vite from
      // an empty cache — 60s is comfortable locally and marginal there.
      timeout: 180_000,
    },
    {
      command: 'pnpm dev:desktop',
      url: 'http://localhost:8080',
      // Locally, attach to whatever dev stack is already running. In CI there
      // is nothing to reuse, and silently attaching to a stale process would
      // test the wrong build.
      reuseExistingServer: !process.env.CI,
      // Cold start in CI compiles TypeScript through tsx and warms Vite from
      // an empty cache — 60s is comfortable locally and marginal there.
      timeout: 180_000,
    },
    {
      command: 'pnpm dev:admin',
      url: 'http://localhost:8082',
      // Locally, attach to whatever dev stack is already running. In CI there
      // is nothing to reuse, and silently attaching to a stale process would
      // test the wrong build.
      reuseExistingServer: !process.env.CI,
      // Cold start in CI compiles TypeScript through tsx and warms Vite from
      // an empty cache — 60s is comfortable locally and marginal there.
      timeout: 180_000,
    },
  ],
});
