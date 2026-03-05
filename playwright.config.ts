import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false, // Tests share state (DB), run sequentially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'html',
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://localhost:8080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],

  // In CI, servers are started manually in the workflow before running tests
  ...(process.env.CI
    ? {}
    : {
        webServer: [
          {
            command: 'pnpm dev:server',
            url: 'http://localhost:3001/health',
            reuseExistingServer: true,
            timeout: 60_000,
          },
          {
            command: 'pnpm dev:desktop',
            url: 'http://localhost:8080',
            reuseExistingServer: true,
            timeout: 60_000,
          },
          {
            command: 'pnpm dev:admin',
            url: 'http://localhost:8082',
            reuseExistingServer: true,
            timeout: 60_000,
          },
        ],
      }),
});
